/**
 * Laptop side of "computer-as-sandbox". Launches `omni sandbox-host` — a thin
 * exec server that turns this machine into a remote sandbox backend for a
 * cloud-hosted agent (see `omniagents.core.sandbox.host_bridge`).
 *
 * The agent itself never runs here; only the sandbox surface (exec / file IO /
 * PTYs) executes against this machine's filesystem. One `omni sandbox-host`
 * process per cloud session, rooted at the session's local workspace dir. The
 * cloud reaches it via the launcher's `/proxy/local/<machineId>/<sessionId>/
 * <execPort>` relay, so the chosen `execPort` is reported back to the cloud.
 *
 * Wired as `compute:ensure-host` / `compute:stop-host` reverse-RPC handlers
 * (see `compute-reverse-handlers.ts`); the cloud calls these before spawning
 * its `omni serve` so the host_bridge profile can point at the live port.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { shellEnvSync } from 'shell-env';

import { SimpleLogger } from '@/lib/simple-logger';
import { getOmniCliPath, getProjectsDir } from '@/main/util';

const DEFAULT_MAX_SESSIONS = 5;

const parseMax = (): number => {
  const raw = process.env['OMNI_LOCAL_COMPUTE_MAX_SESSIONS'];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SESSIONS;
};

/**
 * Re-anchor a cloud-supplied workspace hint onto this machine. The cloud's
 * project records hold cloud-container paths (e.g. `/root/Omni/Workspace/...`)
 * that don't exist here; keep only the basename and re-root under the laptop's
 * own projects dir — a writable, predictable per-project location.
 */
const resolveLocalWorkspace = (hint?: string): string => {
  const base = hint ? path.basename(hint) : '';
  return base ? path.join(getProjectsDir(), base) : getProjectsDir();
};

type HostProc = {
  child: ChildProcess;
  execPort: number;
  workspace: string;
};

export type EnsureHostResult =
  | { ok: true; execPort: number; workspace: string }
  | { ok: false; error: 'machine-at-capacity'; maxSessions: number; currentSessions: number }
  | { ok: false; error: string };

export class SandboxHostManager {
  private readonly log = new SimpleLogger((e) => console[e.level](e.message));
  private readonly procs = new Map<string, HostProc>();
  private readonly max = parseMax();

  /**
   * Ensure an `omni sandbox-host` is running for *sessionId* and return its
   * loopback exec port. Idempotent: a second call for a live session returns
   * the existing port.
   */
  async ensure(sessionId: string, workspaceHint?: string): Promise<EnsureHostResult> {
    const existing = this.procs.get(sessionId);
    if (existing && existing.child.exitCode === null) {
      return { ok: true, execPort: existing.execPort, workspace: existing.workspace };
    }
    if (this.procs.size >= this.max && !existing) {
      return {
        ok: false,
        error: 'machine-at-capacity',
        maxSessions: this.max,
        currentSessions: this.procs.size,
      };
    }

    const workspace = resolveLocalWorkspace(workspaceHint);
    const omniCli = getOmniCliPath();
    const args = ['sandbox-host', '--host', '127.0.0.1', '--port', '0', '--workspace', workspace];
    this.log.info(`[sandbox-host] launching for ${sessionId} at ${workspace}`);

    const child = spawn(omniCli, args, {
      cwd: workspace,
      env: { ...process.env, ...shellEnvSync() } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const execPort = await this.readExecPort(child, sessionId).catch((err: Error) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw err;
    });

    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[sandbox-host:${sessionId}] ${d}`));
    child.on('close', (code) => {
      this.log.info(`[sandbox-host] ${sessionId} exited (code ${code})`);
      const cur = this.procs.get(sessionId);
      if (cur && cur.child === child) {
        this.procs.delete(sessionId);
      }
    });

    this.procs.set(sessionId, { child, execPort, workspace });
    return { ok: true, execPort, workspace };
  }

  /** Resolve the `{"exec_port": N}` readiness line from stdout (10s cap). */
  private readExecPort(child: ChildProcess, sessionId: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`sandbox-host ${sessionId} did not report a port within 10s`));
      }, 10_000);
      const onData = (d: Buffer): void => {
        buf += d.toString();
        for (const line of buf.split(/\r?\n/)) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(t) as { exec_port?: number };
            if (typeof parsed.exec_port === 'number') {
              cleanup();
              resolve(parsed.exec_port);
              return;
            }
          } catch {
            /* keep buffering */
          }
        }
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error(`sandbox-host ${sessionId} exited before reporting a port`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('close', onExit);
      };
      child.stdout?.on('data', onData);
      child.on('close', onExit);
    });
  }

  stop(sessionId: string): void {
    const proc = this.procs.get(sessionId);
    if (!proc) return;
    this.procs.delete(sessionId);
    try {
      proc.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  stopAll(): void {
    for (const id of [...this.procs.keys()]) {
      this.stop(id);
    }
  }
}
