import { type ChildProcess,spawn } from 'child_process';
import { ipcMain, net } from 'electron';

import { getFreePort } from '@/lib/free-port';
import { BUILTIN_EXTENSIONS, getManifest } from '@/main/extensions/registry';
import type { ExtensionManifest } from '@/main/extensions/types';
import type { store as storeInstance } from '@/main/store';

type Store = typeof storeInstance;
import type {
  ExtensionDescriptor,
  ExtensionEnsureResult,
  ExtensionInstanceState,
} from '@/shared/extensions';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents } from '@/shared/types';

/**
 * Stderr ring buffer cap per instance. Keeps memory bounded while preserving
 * enough context to surface a useful error message in the UI.
 */
const STDERR_RING_BYTES = 16 * 1024;

/**
 * Time between readiness probes during startup. Backoff stays linear because
 * marimo typically starts in 1-3s; we just need to not hammer the loopback.
 */
const READINESS_POLL_MS = 250;

/** Grace period between SIGTERM and SIGKILL on shutdown. */
const KILL_GRACE_MS = 3_000;

/** Composite key that uniquely identifies an instance. */
const instanceKey = (id: string, cwd: string): string => `${id}::${cwd}`;

type Instance = {
  manifest: ExtensionManifest;
  cwd: string;
  state: ExtensionInstanceState;
  proc: ChildProcess | null;
  /** Pending startPromise — multiple ensureInstance calls await the same one. */
  startPromise: Promise<ExtensionEnsureResult> | null;
  refcount: number;
  idleTimer: NodeJS.Timeout | null;
  /** Tail of recent stderr lines, capped at STDERR_RING_BYTES. */
  stderrRing: string;
};

type ExtensionManagerArgs = {
  store: Store;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
};

export class ExtensionManager {
  private store: Store;
  private sendToWindow: ExtensionManagerArgs['sendToWindow'];
  private instances = new Map<string, Instance>();

  constructor(args: ExtensionManagerArgs) {
    this.store = args.store;
    this.sendToWindow = args.sendToWindow;
  }

  // ---------------------------------------------------------------------------
  // Descriptor / enable-disable API
  // ---------------------------------------------------------------------------

  listDescriptors = (): ExtensionDescriptor[] => {
    const enabled = this.store.get('enabledExtensions') ?? {};
    return BUILTIN_EXTENSIONS.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: enabled[m.id] === true,
      contentTypes: m.contentTypes,
    }));
  };

  isEnabled = (id: string): boolean => {
    const enabled = this.store.get('enabledExtensions') ?? {};
    return enabled[id] === true;
  };

  setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!getManifest(id)) {
return;
}
    const current = this.store.get('enabledExtensions') ?? {};
    this.store.set('enabledExtensions', { ...current, [id]: enabled });
    if (!enabled) {
      // Tear down any running instances of this extension.
      const toStop = [...this.instances.values()].filter((inst) => inst.manifest.id === id);
      await Promise.allSettled(toStop.map((inst) => this.stopInstance(inst, 'disabled')));
    }
  };

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

  getInstanceStatus = (id: string, cwd: string): ExtensionInstanceState => {
    const inst = this.instances.get(instanceKey(id, cwd));
    return inst ? inst.state : { state: 'idle' };
  };

  getLogs = (id: string, cwd: string): string => {
    return this.instances.get(instanceKey(id, cwd))?.stderrRing ?? '';
  };

  ensureInstance = (id: string, cwd: string): Promise<ExtensionEnsureResult> => {
    if (!this.isEnabled(id)) {
      return Promise.reject(
        new Error(`Extension '${id}' is not enabled. Enable it in Settings → Extensions.`)
      );
    }
    const manifest = getManifest(id);
    if (!manifest) {
      return Promise.reject(new Error(`Unknown extension '${id}'.`));
    }

    const key = instanceKey(id, cwd);
    let inst = this.instances.get(key);

    if (inst) {
      inst.refcount++;
      this.clearIdleTimer(inst);

      if (inst.state.state === 'running') {
        return Promise.resolve({ url: inst.state.url, port: inst.state.port });
      }
      if (inst.startPromise) {
        return inst.startPromise;
      }
      // 'error' or 'idle' — fall through to a fresh start
    } else {
      inst = {
        manifest,
        cwd,
        state: { state: 'idle' },
        proc: null,
        startPromise: null,
        refcount: 1,
        idleTimer: null,
        stderrRing: '',
      };
      this.instances.set(key, inst);
    }

    inst.startPromise = this.startInstance(inst).finally(() => {
      if (inst) {
inst.startPromise = null;
}
    });
    return inst.startPromise;
  };

  releaseInstance = (id: string, cwd: string): void => {
    const inst = this.instances.get(instanceKey(id, cwd));
    if (!inst) {
return;
}
    inst.refcount = Math.max(0, inst.refcount - 1);
    if (inst.refcount === 0) {
      this.scheduleIdleShutdown(inst);
    }
  };

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private startInstance = async (inst: Instance): Promise<ExtensionEnsureResult> => {
    const port = await getFreePort();
    this.transition(inst, { state: 'starting', port });

    const ctx = { cwd: inst.cwd, port };
    const exe = inst.manifest.command.buildExe();
    const args = inst.manifest.command.buildArgs(ctx);
    // Optional env hook — merged on top of the parent process env so the
    // manifest can layer extension-specific variables (e.g. marimo forwards
    // the launcher's Settings → Environment .env file). Failures are
    // swallowed so a broken hook can't take down the spawn.
    let extraEnv: Record<string, string> = {};
    if (inst.manifest.command.buildEnv) {
      try {
        extraEnv = await inst.manifest.command.buildEnv(ctx);
      } catch {
        extraEnv = {};
      }
    }

    const proc = spawn(exe, args, {
      cwd: inst.cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach so the subprocess gets its own process group, letting us SIGTERM
      // the whole tree on shutdown without taking out unrelated children.
      detached: false,
    });
    inst.proc = proc;

    const onStderr = (chunk: Buffer | string) => {
      inst.stderrRing = (inst.stderrRing + String(chunk)).slice(-STDERR_RING_BYTES);
    };
    proc.stdout?.on('data', onStderr);
    proc.stderr?.on('data', onStderr);

    let exitedEarly = false;
    proc.on('exit', (code, signal) => {
      inst.proc = null;
      if (inst.state.state === 'running') {
        this.transition(inst, {
          state: 'error',
          error: `Process exited unexpectedly (code=${code ?? '?'} signal=${signal ?? '?'})`,
          lastStderr: inst.stderrRing,
        });
      }
      exitedEarly = true;
    });

    // Probe readiness
    const baseUrl = inst.manifest.surface.buildBaseUrl({ cwd: inst.cwd, port });
    const probeUrl = baseUrl + inst.manifest.readiness.path;
    const deadline = Date.now() + inst.manifest.readiness.timeoutMs;

    while (Date.now() < deadline) {
      if (exitedEarly) {
        const err = `Subprocess exited before becoming ready. ${inst.stderrRing.slice(-512)}`;
        this.transition(inst, { state: 'error', error: err, lastStderr: inst.stderrRing });
        throw new Error(err);
      }
      try {
        const res = await net.fetch(probeUrl, { method: 'GET' });
        // Any response — even a redirect or 401 — proves the server is up.
        if (res.status > 0) {
          this.transition(inst, {
            state: 'running',
            port,
            url: baseUrl,
            pid: proc.pid ?? 0,
            startedAt: Date.now(),
          });
          return { url: baseUrl, port };
        }
      } catch {
        // not ready yet
      }
      await sleep(READINESS_POLL_MS);
    }

    // Timed out
    const err = `Extension '${inst.manifest.id}' did not become ready within ${inst.manifest.readiness.timeoutMs}ms.`;
    this.transition(inst, { state: 'error', error: err, lastStderr: inst.stderrRing });
    await this.stopInstance(inst, 'timeout');
    throw new Error(err);
  };

  private stopInstance = async (inst: Instance, reason: 'idle' | 'shutdown' | 'disabled' | 'timeout'): Promise<void> => {
    this.clearIdleTimer(inst);
    const proc = inst.proc;
    inst.proc = null;
    if (!proc || proc.exitCode !== null) {
      if (reason !== 'timeout') {
this.transition(inst, { state: 'idle' });
}
      this.instances.delete(instanceKey(inst.manifest.id, inst.cwd));
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
return;
}
        done = true;
        resolve();
      };
      proc.once('exit', finish);
      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        finish();
      }, KILL_GRACE_MS);
    });

    if (reason !== 'timeout') {
      this.transition(inst, { state: 'idle' });
    }
    this.instances.delete(instanceKey(inst.manifest.id, inst.cwd));
  };

  private scheduleIdleShutdown = (inst: Instance): void => {
    this.clearIdleTimer(inst);
    inst.idleTimer = setTimeout(() => {
      if (inst.refcount === 0) {
        void this.stopInstance(inst, 'idle');
      }
    }, inst.manifest.idleShutdownMs);
    inst.idleTimer.unref?.();
  };

  private clearIdleTimer = (inst: Instance): void => {
    if (inst.idleTimer) {
      clearTimeout(inst.idleTimer);
      inst.idleTimer = null;
    }
  };

  private transition = (inst: Instance, next: ExtensionInstanceState): void => {
    inst.state = next;
    this.sendToWindow('extension:status-changed', inst.manifest.id, inst.cwd, next);
  };

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  cleanup = async (): Promise<void> => {
    const all = [...this.instances.values()];
    await Promise.allSettled(all.map((inst) => this.stopInstance(inst, 'shutdown')));
    this.instances.clear();
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// IPC factory
// ---------------------------------------------------------------------------

export const createExtensionManager = (args: {
  ipc: IIpcListener;
  store: Store;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
}) => {
  const { ipc, store, sendToWindow } = args;
  const manager = new ExtensionManager({ store, sendToWindow });

  ipc.handle('extension:list-descriptors', () => manager.listDescriptors());
  ipc.handle('extension:set-enabled', async (_, id, enabled) => {
    await manager.setEnabled(id, enabled);
  });
  ipc.handle('extension:get-instance-status', (_, id, cwd) => manager.getInstanceStatus(id, cwd));
  ipc.handle('extension:ensure-instance', (_, id, cwd) => manager.ensureInstance(id, cwd));
  ipc.handle('extension:release-instance', (_, id, cwd) => {
    manager.releaseInstance(id, cwd);
  });
  ipc.handle('extension:get-logs', (_, id, cwd) => manager.getLogs(id, cwd));

  const cleanup = async () => {
    await manager.cleanup();
    ipcMain.removeHandler('extension:list-descriptors');
    ipcMain.removeHandler('extension:set-enabled');
    ipcMain.removeHandler('extension:get-instance-status');
    ipcMain.removeHandler('extension:ensure-instance');
    ipcMain.removeHandler('extension:release-instance');
    ipcMain.removeHandler('extension:get-logs');
  };

  return [manager, cleanup] as const;
};
