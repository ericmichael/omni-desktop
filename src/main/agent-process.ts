import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import c from 'ansi-colors';
import { shellEnvSync } from 'shell-env';
import { assert } from 'tsafe';
import { WebSocket as WsWebSocket } from 'ws';

import { OMNI_CODE_VERSION } from '@/lib/omni-version';
import { DEFAULT_ENV } from '@/lib/pty-utils';
import { SimpleLogger } from '@/lib/simple-logger';
import type { PlatformClient } from '@/main/platform-client';
import { getStore } from '@/main/store';
import {
  ensureDirectory,
  getBundledBinPath,
  getOmniCliPath,
  getOmniConfigDir,
  isDevelopment,
  isDirectory,
  isFile,
  pathExists,
} from '@/main/util';
import { downloadWorkspace,uploadWorkspace } from '@/main/workspace-sync';
import type {
  AgentProcessData,
  AgentProcessStatus,
  LogEntry,
  NetworkConfig,
  SandboxVariant,
  WithTimestamp,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentProcessMode = 'none' | 'local' | 'sandbox' | 'podman' | 'vm' | 'platform';

export type AgentProcessStartArg = {
  workspaceDir: string;
  sandboxVariant?: SandboxVariant;
  sandboxConfig?: { image?: string; dockerfile?: string } | null;
  /** Enterprise mode: agent slug for platform policy resolution */
  agentSlug?: string;
  /** Enterprise mode: domain slug override */
  domain?: string;
  /** Pre-synced share name from WorkspaceSyncManager (skips one-shot upload). */
  preSyncedShareName?: string;
  /** Git-remote source: container clones this repo instead of receiving an uploaded workspace. */
  gitRepo?: {
    url: string;
    branch?: string;
  };
};

export type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PORT_CONFLICT_PATTERNS = [
  /port is already allocated/i,
  /address already in use/i,
  /bind: address already in use/i,
  /port \d+ is in use/i,
];

type SandboxJsonPayload = {
  sandbox_url: string;
  ws_url: string;
  ui_url: string | null;
  code_server_url: string | null;
  novnc_url: string | null;
  container_id: string | null;
  container_name: string | null;
  ports: {
    sandbox: number;
    ui: number | null;
    code_server: number | null;
    vnc: number | null;
  };
};

const sandboxPayloadToData = (payload: SandboxJsonPayload): AgentProcessData => {
  assert(payload.ui_url, 'Missing ui_url');
  assert(payload.ports.ui, 'Missing ui port');
  return {
    uiUrl: payload.ui_url,
    wsUrl: payload.ws_url,
    sandboxUrl: payload.sandbox_url,
    codeServerUrl: payload.code_server_url ?? undefined,
    noVncUrl: payload.novnc_url ?? undefined,
    containerId: payload.container_id ?? undefined,
    containerName: payload.container_name ?? undefined,
    port: payload.ports.ui,
  };
};

// ---------------------------------------------------------------------------
// AgentProcess
// ---------------------------------------------------------------------------

export class AgentProcess {
  readonly mode: AgentProcessMode;

  private status: WithTimestamp<AgentProcessStatus>;
  private ipcRawOutput: (data: string) => void;
  private onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
  private log: SimpleLogger;
  private childProcess: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private jsonEmitted = false;
  private lastStartArg: AgentProcessStartArg | null = null;
  private fetchFn: FetchFn;
  private platformClient: PlatformClient | null = null;
  private platformSessionId: string | null = null;

  constructor(opts: {
    mode: AgentProcessMode;
    ipcLogger?: (entry: WithTimestamp<LogEntry>) => void;
    ipcRawOutput: (data: string) => void;
    onStatusChange: (status: WithTimestamp<AgentProcessStatus>) => void;
    fetchFn?: FetchFn;
    platformClient?: PlatformClient;
  }) {
    this.mode = opts.mode;
    this.ipcRawOutput = opts.ipcRawOutput;
    this.onStatusChange = opts.onStatusChange;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.platformClient = opts.platformClient ?? null;
    this.status = { type: 'uninitialized', timestamp: Date.now() };
    this.log = new SimpleLogger((entry) => {
      this.ipcRawOutput(entry.message);
      console[entry.level](entry.message);
    });
  }

  // --- Public API ---

  getStatus = (): WithTimestamp<AgentProcessStatus> => this.status;

  start = async (arg: AgentProcessStartArg, options?: { rebuild?: boolean }): Promise<void> => {
    if (this.status.type === 'starting' || this.status.type === 'connecting' || this.status.type === 'running') {
      return;
    }

    this.lastStartArg = arg;
    this.updateStatus({ type: 'starting' });

    // Enterprise mode: delegate to platform
    if (this.mode === 'platform') {
      await this.startPlatformSession(arg);
      return;
    }

    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;

    // Pre-flight checks
    if (this.mode === 'sandbox') {
      const dockerOk = await this.checkDocker(env);
      if (!dockerOk) {
return;
}
    } else if (this.mode === 'podman') {
      const podmanOk = await this.checkPodman(env);
      if (!podmanOk) {
return;
}
    }

    // Git-remote projects don't have a local workspace dir — the container clones the repo
    if (!arg.gitRepo && !(await isDirectory(arg.workspaceDir))) {
      this.updateStatus({ type: 'error', error: { message: `Workspace directory not found: ${arg.workspaceDir}` } });
      return;
    }

    if (this.mode !== 'vm') {
      if (!(await pathExists(getOmniCliPath()))) {
        this.updateStatus({ type: 'error', error: { message: 'Omni runtime is not installed' } });
        return;
      }
    }

    if (this.childProcess) {
      await this.killProcess();
    }

    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.jsonEmitted = false;

    let spawnBinary: string;
    let args: string[];

    if (this.mode === 'sandbox' || this.mode === 'podman') {
      spawnBinary = getOmniCliPath();
      args = await this.buildSandboxArgs(arg, options);
      if (this.mode === 'podman') {
        env.OMNI_CONTAINER_RUNTIME = 'podman';
      }
    } else if (this.mode === 'vm') {
      const sandboxBinName = process.platform === 'win32' ? 'omni-sandbox.exe' : 'omni-sandbox';
      spawnBinary = join(getBundledBinPath(), sandboxBinName);

      if (!(await pathExists(spawnBinary))) {
        this.updateStatus({
          type: 'error',
          error: { message: `Sandbox binary not found: ${spawnBinary}` },
        });
        return;
      }

      args = await this.buildVmArgs(arg);
    } else if (this.mode === 'local') {
      // Local mode — wrap in omni-sandbox for process isolation (bwrap + seccomp).
      const sandboxBinName = process.platform === 'win32' ? 'omni-sandbox.exe' : 'omni-sandbox';
      spawnBinary = join(getBundledBinPath(), sandboxBinName);

      if (!(await pathExists(spawnBinary))) {
        this.updateStatus({
          type: 'error',
          error: { message: `Sandbox binary not found: ${spawnBinary}` },
        });
        return;
      }

      args = await this.buildLocalArgs(arg);
    } else {
      // None mode — run omni CLI directly, no sandboxing.
      spawnBinary = getOmniCliPath();
      args = await this.buildDirectArgs(arg);
    }

    const modeLabels: Record<AgentProcessMode, string> = {
      none: 'agent',
      local: 'agent (sandboxed)',
      sandbox: 'sandbox',
      podman: 'sandbox (Podman)',
      vm: 'VM sandbox',
      platform: 'platform sandbox',
    };
    this.log.info(c.cyan(`Starting ${modeLabels[this.mode]}...\r\n`));
    this.log.info(`> ${spawnBinary} ${args.join(' ')}\r\n`);

    // In none/local mode we know the port upfront — start readiness polling immediately
    if (this.mode === 'local' || this.mode === 'none') {
      const portMatch = args.find((a, i) => i > 0 && args[i - 1] === '--port');
      const port = portMatch ? parseInt(portMatch, 10) : 8000;
      const uiUrl = `http://127.0.0.1:${port}`;
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const data: AgentProcessData = { uiUrl, wsUrl, port };
      this.jsonEmitted = true;
      this.updateStatus({ type: 'connecting', data });
      void this.waitForReady(data);
    }

    try {
      const child = spawn(spawnBinary, args, {
        cwd: arg.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.childProcess = child;

      child.stdout.on('data', this.handleStdout);
      child.stderr.on('data', this.handleStderr);

      child.on('error', (error: Error) => {
        if (this.childProcess && this.childProcess !== child) {
return;
}
        this.childProcess = null;
        this.updateStatus({ type: 'error', error: { message: error.message } });
      });

      child.on('close', (exitCode, signal) => {
        if (this.childProcess && this.childProcess !== child) {
return;
}
        this.childProcess = null;

        if (this.status.type === 'exiting' || this.status.type === 'stopping') {
          this.updateStatus({ type: 'exited' });
          return;
        }
        if (exitCode === 0) {
          this.updateStatus({ type: 'exited' });
          return;
        }
        if ((this.mode === 'sandbox' || this.mode === 'podman') && this.detectPortConflict()) {
          this.updateStatus({
            type: 'error',
            error: {
              message: 'A port required by the sandbox is already in use. Stop conflicting services or containers and try again.',
            },
          });
          return;
        }

        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        const tail = this.tailStderr();
        const message = tail
          ? `Process exited (${reason})\n\n${tail}`
          : `Process exited (${reason})`;
        this.updateStatus({ type: 'error', error: { message } });
      });
    } catch (error) {
      this.childProcess = null;
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  stop = async (): Promise<void> => {
    // Enterprise mode: stop via platform API
    if (this.mode === 'platform') {
      this.updateStatus({ type: 'stopping' });
      if (this.platformSessionId && this.platformClient) {
        const sessionId = this.platformSessionId;
        try {
          await this.platformClient.stopSession(sessionId);
        } catch {
          // best-effort cleanup
        }

        // Download workspace files back from Azure Files share
        // Skip if: sync manager handles it, or git-remote (container pushes to git)
        if (this.lastStartArg && !this.lastStartArg.preSyncedShareName && !this.lastStartArg.gitRepo) {
          try {
            this.ipcRawOutput('Finalizing workspace download...\r\n');
            const { downloadSasUrl } = await this.platformClient.finalizeWorkspace(sessionId);
            await downloadWorkspace(this.lastStartArg.workspaceDir, downloadSasUrl, this.fetchFn, (msg) =>
              this.ipcRawOutput(`${msg  }\r\n`)
            );
            this.ipcRawOutput('Workspace downloaded successfully\r\n');
          } catch (error) {
            this.ipcRawOutput(`Workspace download failed: ${(error as Error).message}\r\n`);
          }
        }

        this.platformSessionId = null;
      }
      this.updateStatus({ type: 'exited' });
      return;
    }

    if (!this.childProcess) {
      if (this.mode === 'sandbox' || this.mode === 'podman') {
        const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
        await this.stopActiveContainer(env);
      }
      return;
    }

    this.updateStatus({ type: 'stopping' });
    const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
    await this.killProcess();
    if (this.mode === 'sandbox' || this.mode === 'podman') {
      await this.stopActiveContainer(env);
    }
    this.updateStatus({ type: 'exited' });
  };

  rebuild = async (fallbackArg: AgentProcessStartArg): Promise<void> => {
    const arg = this.lastStartArg ?? fallbackArg;
    await this.stop();
    await this.start(arg, { rebuild: true });
  };

  exit = async (): Promise<void> => {
    this.updateStatus({ type: 'exiting' });
    await this.stop();
  };

  resizePty = (_cols: number, _rows: number): void => {};

  // --- Platform mode ---

  private startPlatformSession = async (arg: AgentProcessStartArg): Promise<void> => {
    if (!this.platformClient) {
      this.updateStatus({ type: 'error', error: { message: 'Platform client not configured' } });
      return;
    }

    const agentSlug = arg.agentSlug ?? 'omni-code';

    try {
      this.log.info(c.cyan(`Requesting sandbox from platform (agent: ${agentSlug})...\r\n`));

      const session = await this.platformClient.startSession(agentSlug, arg.domain, arg.gitRepo);
      this.platformSessionId = session.sessionId;

      if (arg.gitRepo) {
        // Git-remote: container will clone the repo — no workspace upload needed
        this.log.info(c.cyan(`Container will clone ${arg.gitRepo.url}${arg.gitRepo.branch ? ` (${arg.gitRepo.branch})` : ''}\r\n`));
      } else if (arg.preSyncedShareName) {
        // Workspace is already synced via WorkspaceSyncManager — skip upload
        this.log.info(c.cyan(`Using pre-synced share: ${arg.preSyncedShareName}\r\n`));
      } else {
        // One-shot upload for non-synced workspaces
        this.log.info(c.cyan(`Preparing workspace upload for session ${session.sessionId}...\r\n`));
        const { uploadSasUrl } = await this.platformClient.prepareWorkspace(session.sessionId);
        await uploadWorkspace(arg.workspaceDir, uploadSasUrl, this.fetchFn, (msg) =>
          this.ipcRawOutput(`${msg  }\r\n`)
        );
        this.log.info(c.cyan('Workspace uploaded successfully\r\n'));
      }

      this.log.info(c.cyan(`Session ${session.sessionId} created, waiting for container...\r\n`));
      this.updateStatus({ type: 'connecting', data: { uiUrl: '' } });

      const ready = await this.platformClient.waitForSession(session.sessionId);
      if (this.isStopping()) {
return;
}

      const wsUrl = ready.websocketUrl!;
      let uiUrl = wsUrl.replace(/^wss?:/, 'https:').replace(/\/ws$/, '');
      // Include auth token so the agent UI can authenticate WebSocket connections
      if (ready.authToken) {
        const sep = uiUrl.includes('?') ? '&' : '?';
        uiUrl = `${uiUrl}${sep}token=${encodeURIComponent(ready.authToken)}`;
      }
      const data: AgentProcessData = {
        uiUrl,
        wsUrl,
        containerId: ready.containerId,
      };

      // Transition to 'connecting' and wait for the container's HTTP/WS endpoints
      // to actually accept connections before marking as 'running'. The platform
      // reports 'active' when the container starts, but services inside may still
      // be booting.
      this.updateStatus({ type: 'connecting', data });
      this.log.info(c.cyan('Waiting for platform container services to accept connections...\r\n'));
      await this.waitForReady(data);
    } catch (error) {
      if (this.isStopping()) {
return;
}
      this.updateStatus({ type: 'error', error: { message: (error as Error).message } });
    }
  };

  // --- Internals ---

  private isStopping = (): boolean => {
    const t = this.status.type;
    return t === 'stopping' || t === 'exiting';
  };

  private updateStatus = (status: AgentProcessStatus): void => {
    this.status = { ...status, timestamp: Date.now() };
    this.onStatusChange(this.status);
  };

  // -- Argument builders --

  private buildLocalArgs = async (arg: AgentProcessStartArg): Promise<string[]> => {
    const port = await this.pickAvailablePort();
    const omniCliPath = getOmniCliPath();

    const sandboxArgs: string[] = [
      '--workspace', arg.workspaceDir,
    ];

    // Read network config — same logic as sandbox mode.
    const networkHosts = await this.readNetworkAllowlist();
    if (networkHosts.length > 0) {
      sandboxArgs.push('--net-allow', networkHosts.join(','));
    } else {
      // Agent needs localhost network to serve its HTTP/WS endpoints.
      sandboxArgs.push('--net');
    }

    // The omni CLI and its venv must be readable inside the sandbox.
    const omniVenvDir = join(omniCliPath, '..', '..');
    sandboxArgs.push('--ro-bind', omniVenvDir);

    // If packages are editable (dev) installs, their source directories live
    // outside the venv and must be mounted separately.
    const editableSourceDirs = await this.findEditableSourceDirs(omniVenvDir);
    for (const dir of editableSourceDirs) {
      sandboxArgs.push('--ro-bind', dir);
    }

    // Omni config dir (contains .env, network.json, model config).
    const omniConfigDir = getOmniConfigDir();
    if (await pathExists(omniConfigDir)) {
      sandboxArgs.push('--ro-bind', omniConfigDir);
    }

    // OmniAgents home dir (traces, sessions, audit) — needs write access.
    const home = homedir();
    const omniagentsHome = process.env['OMNIAGENTS_HOME'] || join(home, '.omniagents');
    await ensureDirectory(omniagentsHome);
    sandboxArgs.push('--rw-bind', omniagentsHome);

    // OmniAgents cache dir — needs write access.
    const cacheBase = process.env['XDG_CACHE_HOME'] || join(home, '.cache');
    const omniagentsCache = join(cacheBase, 'omniagents');
    await ensureDirectory(omniagentsCache);
    sandboxArgs.push('--rw-bind', omniagentsCache);

    // Git worktree support: when the workspace is a worktree, .git is a file
    // pointing to the parent repo's .git/worktrees/<name>/ directory. Git needs
    // write access to that directory (and the shared object store) for commits,
    // ref updates, etc. Without this, all git writes fail inside the sandbox.
    const parentGitDir = await this.detectWorktreeGitDir(arg.workspaceDir);
    if (parentGitDir) {
      sandboxArgs.push('--rw-bind', parentGitDir);
    }

    // Separator between sandbox args and the wrapped command.
    sandboxArgs.push('--');
    sandboxArgs.push(omniCliPath, '--mode', 'server', '--host', '127.0.0.1', '--port', String(port));

    return sandboxArgs;
  };

  /** Build args for direct (unsandboxed) omni CLI invocation. */
  private buildDirectArgs = async (_arg: AgentProcessStartArg): Promise<string[]> => {
    const port = await this.pickAvailablePort();
    return ['--mode', 'server', '--host', '127.0.0.1', '--port', String(port)];
  };

  private buildVmArgs = async (arg: AgentProcessStartArg): Promise<string[]> => {
    const vmArgs: string[] = [
      'vm', 'run',
      '--workspace', arg.workspaceDir,
      '--output', 'json',
    ];

    const networkHosts = await this.readNetworkAllowlist();
    if (networkHosts.length > 0) {
      vmArgs.push('--net-allow', networkHosts.join(','));
    }

    return vmArgs;
  };

  /**
   * Find all editable (dev) installs in a Python root and return their
   * source directories so they can be mounted into the sandbox.
   */
  private findEditableSourceDirs = async (pythonRoot: string): Promise<string[]> => {
    try {
      const libDir = join(pythonRoot, 'lib');
      const libEntries = await readdir(libDir);
      const pythonDir = libEntries.find((e) => e.startsWith('python'));
      if (!pythonDir) {
return [];
}

      const spDir = join(libDir, pythonDir, 'site-packages');
      const spEntries = await readdir(spDir);
      const finderFiles = spEntries.filter((e) => e.startsWith('__editable___') && e.endsWith('_finder.py'));

      const dirs = new Set<string>();
      for (const f of finderFiles) {
        const content = await readFile(join(spDir, f), 'utf-8');
        // Extract all source paths from the MAPPING dict
        const re = /:\s*'([^']+)'/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const srcPath = m[1]!;
          if (srcPath.startsWith('/')) {
            dirs.add(resolve(srcPath, '..'));
          }
        }
      }
      return [...dirs];
    } catch {
      return [];
    }
  };

  /**
   * Detect if a workspace is a git worktree and return the parent repo's .git
   * directory. In a worktree, `.git` is a file containing `gitdir: <path>` that
   * points to `<repo>/.git/worktrees/<name>`. We return the parent `.git` dir
   * so it can be rw-bind mounted, giving git full write access to refs, objects,
   * and worktree-specific state.
   */
  private detectWorktreeGitDir = async (workspaceDir: string): Promise<string | null> => {
    try {
      const dotGit = join(workspaceDir, '.git');
      const st = await stat(dotGit);
      if (!st.isFile()) {
return null;
}

      const content = (await readFile(dotGit, 'utf-8')).trim();
      if (!content.startsWith('gitdir:')) {
return null;
}

      const gitdirValue = content.slice('gitdir:'.length).trim();
      const gitdirPath = resolve(workspaceDir, gitdirValue);

      // Expect: …/.git/worktrees/<name> — parent must be "worktrees"
      const parent = resolve(gitdirPath, '..');
      if (basename(parent) !== 'worktrees') {
return null;
}

      const parentGitDir = resolve(parent, '..');
      if (!(await isDirectory(parentGitDir))) {
return null;
}

      return parentGitDir;
    } catch {
      return null;
    }
  };

  /** Read network allowlist from omni config dir. */
  private readNetworkAllowlist = async (): Promise<string[]> => {
    try {
      const omniConfigDir = getOmniConfigDir();
      const networkJson = await readFile(join(omniConfigDir, 'network.json'), 'utf-8');
      const networkConfig = JSON.parse(networkJson) as NetworkConfig;
      if (networkConfig.enabled) {
        const hosts = networkConfig.allowlist ?? (networkConfig as Record<string, unknown>)['allowedHosts'] ?? [];
        return hosts as string[];
      }
    } catch {
      // network.json missing or invalid
    }
    return [];
  };

  /** Pick an available TCP port by briefly binding to port 0. */
  private pickAvailablePort = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as import('node:net').AddressInfo;
        const port = addr.port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  };

  private buildSandboxArgs = async (
    arg: AgentProcessStartArg,
    options?: { rebuild?: boolean }
  ): Promise<string[]> => {
    const variant = arg.sandboxVariant ?? 'work';
    const args: string[] = [
      'sandbox', '--mode', 'server',
      '--ui', 'local', '--ui-host', '0.0.0.0', '--ui-port', '0',
      '--port', '0',
      '--workspace', arg.workspaceDir,
      '--output', 'json',
    ];

    const omniConfigDir = getOmniConfigDir();

    const envFilePath = join(omniConfigDir, '.env');
    if (await isFile(envFilePath)) {
      args.push('--env-file', envFilePath);
    }

    const networkHosts = await this.readNetworkAllowlist();
    if (networkHosts.length > 0) {
      args.push('--network-allowlist', networkHosts.join(','));
    }

    // Gated behind preview features: code-server and VNC desktop are experimental surfaces.
    // Enterprise policy also opts in via sandboxProfiles (same gate as the sandbox UI).
    const store = getStore();
    const previewFeatures = store.get('previewFeatures') ?? false;
    const hasEnterpriseProfiles = (store.get('sandboxProfiles') ?? null) !== null;
    if (previewFeatures || hasEnterpriseProfiles) {
      args.push('--enable-code-server', '--code-server-port', '0');
      args.push('--enable-vnc', '--vnc-port', '0');
    }

    if (arg.sandboxConfig?.image) {
      args.push('--image', arg.sandboxConfig.image);
    } else if (arg.sandboxConfig?.dockerfile) {
      args.push('--dockerfile', resolve(arg.workspaceDir, arg.sandboxConfig.dockerfile));
      args.push('--build-arg', `OMNI_CODE_VERSION=${OMNI_CODE_VERSION}`);
    } else if (!isDevelopment()) {
      // Production: use pre-built image from registry
      const imageSuffix = variant === 'work' ? '-work' : '';
      args.push('--image', `ghcr.io/ericmichael/omni-code-sandbox${imageSuffix}:latest`);
    }
    // Dev mode: omni sandbox resolves its own Dockerfile from omni_code/sandbox/

    args.push('--persist-volume', 'omni-gh:/home/user/.config/gh');

    if (variant === 'work') {
      args.push('--persist-volume', 'omni-azure:/home/user/.azure');
      args.push('--persist-volume', 'omni-gitconfig:/home/user/.gitconfig.d');
      args.push('--persist-volume', 'omni-ssh:/home/user/.ssh');
      args.push('--persist-volume', 'omni-npm:/home/user/.npmrc');
    }

    if (options?.rebuild) {
      args.push('--rebuild');
    }

    // Git-remote: pass repo info so the container clones instead of expecting a mounted workspace
    if (arg.gitRepo) {
      args.push('--env', `OMNI_GIT_REPO_URL=${arg.gitRepo.url}`);
      if (arg.gitRepo.branch) {
        args.push('--env', `OMNI_GIT_BRANCH=${arg.gitRepo.branch}`);
      }
    }

    return args;
  };

  // -- Stdout/stderr handling --

  private handleStdout = (data: Buffer): void => {
    const str = data.toString();
    this.ipcRawOutput(str);
    process.stdout.write(str);

    if (this.jsonEmitted) {
return;
}

    this.stdoutBuffer += str;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.tryParseStdoutLine(line);
    }
  };

  private handleStderr = (data: Buffer): void => {
    const str = data.toString();
    this.stderrBuffer += str;
    this.ipcRawOutput(str);
    process.stderr.write(str);
  };

  private tryParseStdoutLine = (line: string): void => {
    if (this.jsonEmitted) {
return;
}

    const trimmed = line.trim();

    // Try JSON first (sandbox mode outputs structured JSON, web mode outputs {"url", "port"})
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (this.mode === 'sandbox' || this.mode === 'podman' || this.mode === 'vm') {
        if (!('sandbox_url' in parsed) || !('ui_url' in parsed)) {
return;
}
        const data = sandboxPayloadToData(parsed as unknown as SandboxJsonPayload);
        this.jsonEmitted = true;
        this.updateStatus({ type: 'connecting', data });
        this.log.info(c.cyan('Waiting for services to accept connections...\r\n'));
        void this.waitForReady(data);
      } else {
        if (typeof parsed.url !== 'string' || typeof parsed.port !== 'number') {
return;
}
        const data: AgentProcessData = { uiUrl: parsed.url as string, port: parsed.port as number };
        this.jsonEmitted = true;
        this.updateStatus({ type: 'connecting', data });
        this.log.info(c.cyan('Waiting for agent to accept connections...\r\n'));
        void this.waitForReady(data);
      }
      return;
    }
  };

  // -- Readiness polling --

  private waitForReady = async (data: AgentProcessData): Promise<void> => {
    const isContainerMode = this.mode === 'sandbox' || this.mode === 'podman' || this.mode === 'vm';
    const maxAttempts = isContainerMode ? 120 : this.mode === 'platform' ? 120 : 30;

    const checkHttp = async (url: string): Promise<boolean> => {
      try {
        const response = await this.fetchFn(url, { method: 'GET' });
        return response.status < 500;
      } catch {
        return false;
      }
    };

    const checkWs = async (url: string): Promise<boolean> => {
      try {
        return await new Promise<boolean>((resolve) => {
          let settled = false;
          const socket = new WsWebSocket(url);
          const finish = (result: boolean): void => {
            if (settled) {
return;
}
            settled = true;
            clearTimeout(timer);
            try {
 socket.close(); 
} catch {}
            resolve(result);
          };
          const timer = setTimeout(() => finish(false), 2_000);
          socket.on('open', () => finish(true));
          socket.on('error', () => finish(false));
          socket.on('close', () => finish(false));
        });
      } catch {
        return false;
      }
    };

    // For platform mode, extract the auth token from uiUrl and apply to wsUrl checks
    // since the container may require token auth on WS connections.
    let wsCheckUrl = data.wsUrl;
    if (wsCheckUrl && this.mode === 'platform') {
      try {
        const uiParsed = new URL(data.uiUrl);
        const token = uiParsed.searchParams.get('token');
        if (token) {
          const wsUrlObj = new URL(wsCheckUrl);
          wsUrlObj.searchParams.set('token', token);
          wsCheckUrl = wsUrlObj.toString();
        }
      } catch { /* ignore parse errors */ }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStopping()) {
return;
}

      const httpOk = await checkHttp(data.uiUrl);
      const wsOk = wsCheckUrl ? await checkWs(wsCheckUrl) : true;

      if (httpOk && wsOk) {
        if (this.isStopping()) {
return;
}
        this.updateStatus({ type: 'running', data });
        const label = this.mode === 'sandbox' ? 'Sandbox' : this.mode === 'podman' ? 'Sandbox (Podman)' : this.mode === 'vm' ? 'VM sandbox' : this.mode === 'platform' ? 'Platform sandbox' : 'Agent';
        this.log.info(c.green.bold(`${label} started\r\n`));
        return;
      }

      await new Promise<void>((r) => setTimeout(r, 1000));
    }

    if (this.isStopping()) {
return;
}

    // Timeout
    if (this.mode === 'sandbox' || this.mode === 'podman') {
      const env = { ...process.env, ...DEFAULT_ENV } as Record<string, string>;
      void this.stopActiveContainer(env);
    }
    this.updateStatus({
      type: 'error',
      error: { message: `Services did not become ready within ${maxAttempts} seconds.` },
    });
  };

  // -- Process management --

  private killProcess = (timeout = 10_000): Promise<void> => {
    const child = this.childProcess;
    if (!child || child.exitCode !== null) {
      this.childProcess = null;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        this.childProcess = null;
        resolve();
      };
      child.once('close', onExit);
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        child.removeListener('close', onExit);
        child.kill('SIGKILL');
        this.childProcess = null;
        resolve();
      }, timeout);
    });
  };

  // -- Container helpers (sandbox / podman modes) --

  /** The container CLI binary name for the current mode. */
  private get containerBin(): string {
    return this.mode === 'podman' ? 'podman' : 'docker';
  }

  private checkDocker = async (env: Record<string, string>): Promise<boolean> => {
    try {
      await execFileAsync('docker', ['version'], { encoding: 'utf8', timeout: 10_000, env });
      return true;
    } catch {
      this.updateStatus({
        type: 'error',
        error: { message: 'Docker is not available. Install Docker Desktop / docker-ce and ensure it is running.' },
      });
      return false;
    }
  };

  private checkPodman = async (env: Record<string, string>): Promise<boolean> => {
    try {
      await execFileAsync('podman', ['version'], { encoding: 'utf8', timeout: 10_000, env });
      return true;
    } catch {
      this.updateStatus({
        type: 'error',
        error: { message: 'Podman is not available. Install podman and ensure the podman machine is running.' },
      });
      return false;
    }
  };

  private getActiveContainerRef = (): string | null => {
    if (this.status.type !== 'running' && this.status.type !== 'connecting') {
return null;
}
    return this.status.data.containerName ?? this.status.data.containerId ?? null;
  };

  private stopActiveContainer = async (env: Record<string, string>): Promise<void> => {
    const containerRef = this.getActiveContainerRef();
    if (!containerRef) {
return;
}
    try {
      await execFileAsync(this.containerBin, ['stop', containerRef], { encoding: 'utf8', timeout: 15_000, env });
    } catch {
      // ignore cleanup failures
    }
  };

  /**
   * Execute a command inside the running container. Returns true on exit 0.
   * Uses docker/podman exec for local container modes, platform API for platform mode.
   */
  execInContainer = async (command: string, cwd?: string, timeoutMs = 60_000): Promise<boolean> => {
    // Platform mode — delegate to the platform exec API
    if (this.mode === 'platform') {
      if (!this.platformClient || !this.platformSessionId) {
        this.log.warn('execInContainer: no platform session');
        return false;
      }
      try {
        const result = await this.platformClient.execInSession(
          this.platformSessionId,
          command,
          cwd,
          Math.floor(timeoutMs / 1000)
        );
        if (result.stderr) {
this.log.info(`[exec] ${result.stderr.trim()}`);
}
        return result.success;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`execInContainer (platform) failed: ${msg}`);
        return false;
      }
    }

    // Local/none modes have no container to exec into
    if (this.mode === 'local' || this.mode === 'none') {
      this.log.warn(`execInContainer not supported for mode: ${  this.mode}`);
      return true;
    }

    // Docker/podman — exec directly
    const containerRef = this.getActiveContainerRef();
    if (!containerRef) {
      this.log.warn('execInContainer: no running container');
      return false;
    }
    const args = ['exec'];
    if (cwd) {
args.push('-w', cwd);
}
    args.push(containerRef, '/bin/sh', '-c', command);

    try {
      const env = { ...process.env, ...DEFAULT_ENV, ...shellEnvSync() } as Record<string, string>;
      const { stderr } = await execFileAsync(this.containerBin, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        env,
      });
      if (stderr) {
this.log.info(`[exec] ${stderr.trim()}`);
}
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`execInContainer failed: ${msg}`);
      return false;
    }
  };

  private detectPortConflict = (): boolean => {
    return PORT_CONFLICT_PATTERNS.some((pattern) => pattern.test(this.stderrBuffer));
  };

  // eslint-disable-next-line no-control-regex
  private static readonly ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

  private tailStderr = (maxLines = 20, maxChars = 2000): string => {
    const cleaned = this.stderrBuffer.replace(AgentProcess.ANSI_RE, '');
    const lines = cleaned.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
    const tail = lines.slice(-maxLines).join('\n');
    if (tail.length <= maxChars) return tail;
    return `…${tail.slice(tail.length - maxChars)}`;
  };
}
