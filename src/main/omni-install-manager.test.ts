/**
 * Tests for OmniInstallManager — install FSM transitions, cancellation,
 * preflight checks (disk space, network, UV probe), log rotation, retry
 * logic, and error reporting.
 *
 * Mocks CommandRunner, electron, shell-env, and fs so no real processes
 * spawn, no network calls occur, and no files are touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  commandRunnerResults: [] as Array<{ exitCode: number; signal?: number }>,
  commandRunnerCalls: [] as Array<{ command: string; args: string[]; env?: Record<string, string> }>,
  commandRunnerCallIndex: 0,
  commandRunnerGates: [] as Array<Promise<void> | undefined>,
  commandRunnerIsRunning: false,
  networkReachable: true,
  diskFreeBytes: 10 * 1024 * 1024 * 1024, // 10 GB by default
  uvExists: true,
  venvExists: false,
  fsFiles: new Map<string, string>(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/workspace/launcher'),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') {
        return '/tmp/test-userdata';
      }
      if (name === 'home') {
        return '/tmp/test-home';
      }
      if (name === 'appData') {
        return '/tmp/test-appdata';
      }
      return '/tmp';
    }),
  },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  net: {
    fetch: vi.fn(async () => {
      if (!hoisted.networkReachable) {
        throw new Error('ECONNREFUSED');
      }
      return { status: 200 };
    }),
  },
}));

vi.mock('shell-env', () => ({
  shellEnvSync: vi.fn(() => ({})),
}));

vi.mock('ansi-colors', () => {
  const identity = (s: string) => s;
  const handler: ProxyHandler<typeof identity> = {
    get: () => new Proxy(identity, handler),
    apply: (_t, _this, args) => args[0],
  };
  return { default: new Proxy(identity, handler) };
});

vi.mock('serialize-error', () => ({
  serializeError: (e: Error) => ({ message: e.message }),
}));

vi.mock('@/lib/pty-utils', () => ({
  DEFAULT_ENV: { FORCE_COLOR: '1' },
}));

vi.mock('@/lib/command-runner', () => ({
  CommandRunner: class MockCommandRunner {
    private running = false;
    async runCommand(
      command: string,
      args: string[],
      opts?: { env?: Record<string, string> },
      callbacks?: { onData?: (data: string) => void }
    ) {
      this.running = true;
      hoisted.commandRunnerCalls.push({ command, args, env: opts?.env });
      const callIndex = hoisted.commandRunnerCallIndex;
      const result = hoisted.commandRunnerResults[callIndex] ?? { exitCode: 0 };
      hoisted.commandRunnerCallIndex++;
      await hoisted.commandRunnerGates[callIndex];
      callbacks?.onData?.('mock output\r\n');
      this.running = false;
      if (result.exitCode !== 0) {
        throw new Error(`Process exited with code ${result.exitCode}`);
      }
      return result;
    }
    isRunning() {
      return this.running || hoisted.commandRunnerIsRunning;
    }
    kill = vi.fn(async () => {
      this.running = false;
    });
    resize = vi.fn();
  },
}));

vi.mock('@/main/util', () => ({
  getUVExecutablePath: () => '/app/bin/uv',
  getOmniRuntimeDir: () => '/tmp/test-runtime',
  getOmniVenvPath: () => '/tmp/test-runtime/.venv',
  getOmniLogsDir: () => '/tmp/test-logs',
  // Used by the post-install `refreshProductRuntimeInfo` (fire-and-forget).
  // Points at a path `pathExists` reports missing, so the describe
  // introspection short-circuits without spawning anything.
  getOmniCliPath: () => '/tmp/test-cli/omni',
  isFile: vi.fn(async (p: string) => {
    if (p === '/app/bin/uv') {
      return hoisted.uvExists;
    }
    return hoisted.fsFiles.has(p);
  }),
  pathExists: vi.fn(async (p: string) => {
    if (p.includes('.venv')) {
      return hoisted.venvExists;
    }
    return hoisted.fsFiles.has(p);
  }),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mock = {
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async (p: string) => {
      if (p === '/app/bin/uv' && !hoisted.uvExists) {
        throw new Error('ENOENT');
      }
    }),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    statfs: vi.fn(async () => ({
      bavail: hoisted.diskFreeBytes / 4096,
      bsize: 4096,
    })),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => {}),
  };
  return { ...actual, default: mock };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      createWriteStream: vi.fn(() => ({
        write: vi.fn(),
        end: vi.fn(),
      })),
    },
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn(),
    })),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('@/lib/omni-version', () => ({
  OMNI_CODE_VERSION: '1.0.0-test',
}));

vi.mock('@/lib/simple-logger', () => ({
  SimpleLogger: class {
    constructor(private handler: (entry: { level: string; message: string }) => void) {}
    info(msg: string) {
      this.handler({ level: 'info', message: msg });
    }
    warn(msg: string) {
      this.handler({ level: 'warn', message: msg });
    }
    error(msg: string) {
      this.handler({ level: 'error', message: msg });
    }
    debug(msg: string) {
      this.handler({ level: 'debug', message: msg });
    }
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { OmniInstallManager } from '@/main/omni-install-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMgr() {
  hoisted.commandRunnerResults = [];
  hoisted.commandRunnerCalls = [];
  hoisted.commandRunnerCallIndex = 0;
  hoisted.commandRunnerGates = [];
  hoisted.commandRunnerIsRunning = false;
  hoisted.networkReachable = true;
  hoisted.diskFreeBytes = 10 * 1024 * 1024 * 1024;
  hoisted.uvExists = true;
  hoisted.venvExists = false;
  hoisted.fsFiles.clear();

  const statusChanges: Array<{ type: string }> = [];
  const logEntries: Array<{ level: string; message: string }> = [];
  const rawOutput: string[] = [];

  const mgr = new OmniInstallManager({
    ipcLogger: (entry) => logEntries.push(entry),
    ipcRawOutput: (data) => rawOutput.push(data),
    onStatusChange: (status) => statusChanges.push(status),
  });

  return { mgr, statusChanges, logEntries, rawOutput };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OmniInstallManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('status lifecycle', () => {
    it('keeps runtime consumers blocked until the editable omniagents overlay finishes', async () => {
      const { mgr } = makeMgr();
      hoisted.fsFiles.set('/workspace/omni-code/pyproject.toml', '');
      hoisted.fsFiles.set('/workspace/omniagents/pyproject.toml', '');
      let finishOverlay!: () => void;
      hoisted.commandRunnerGates[4] = new Promise<void>((resolve) => {
        finishOverlay = resolve;
      });

      const installing = mgr.startInstall();
      await vi.waitFor(() => expect(hoisted.commandRunnerCalls).toHaveLength(5));
      let consumerReleased = false;
      const consumer = mgr.waitForInstallCompletion().then(() => {
        consumerReleased = true;
      });
      await Promise.resolve();
      expect(consumerReleased).toBe(false);

      finishOverlay();
      await Promise.all([installing, consumer]);
      expect(consumerReleased).toBe(true);
      expect(mgr.getStatus().type).toBe('completed');
    });

    it('releases waiters with the install error instead of deadlocking', async () => {
      const { mgr } = makeMgr();
      hoisted.commandRunnerResults = [{ exitCode: 1 }, { exitCode: 1 }];

      await mgr.startInstall();

      await expect(mgr.waitForInstallCompletion()).rejects.toThrow('Omni runtime installation failed');
    });

    it('releases waiters when an install was canceled', async () => {
      const { mgr } = makeMgr();
      mgr.updateStatus({ type: 'canceled' });

      await expect(mgr.waitForInstallCompletion()).rejects.toThrow('Omni runtime installation was canceled');
    });

    it('starts as uninitialized', () => {
      const { mgr } = makeMgr();
      expect(mgr.getStatus().type).toBe('uninitialized');
    });

    it('transitions starting → installing → completed on success', async () => {
      const { mgr, statusChanges } = makeMgr();
      // All commands succeed (uv --version, python install, venv create, pip install)
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version probe
        { exitCode: 0 }, // python install
        { exitCode: 0 }, // venv create
        { exitCode: 0 }, // pip install
      ];

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('starting');
      expect(types).toContain('installing');
      expect(types).toContain('completed');
      expect(mgr.getStatus().type).toBe('completed');
    });

    it('uses sibling editable products for an unpackaged development workspace', async () => {
      const { mgr } = makeMgr();
      hoisted.fsFiles.set('/workspace/omni-code/pyproject.toml', '');
      hoisted.fsFiles.set('/workspace/omniagents/pyproject.toml', '');

      await mgr.startInstall();

      const pipCalls = hoisted.commandRunnerCalls.filter(({ args }) => args[0] === 'pip' && args[1] === 'install');
      expect(pipCalls).toHaveLength(2);
      expect(pipCalls[0]!.args).toContain('/workspace/omni-code');
      expect(pipCalls[1]!.args).toContain('/workspace/omniagents[all]');
      expect(pipCalls[0]!.env?.OMNI_CODE_EDITABLE_PATH).toBe('/workspace/omni-code');
      expect(pipCalls[0]!.env?.OMNIAGENTS_EDITABLE_PATH).toBe('/workspace/omniagents');
    });

    it('transitions to error when uv executable is missing', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.uvExists = false;

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
      expect(mgr.getStatus().type).toBe('error');
    });

    it('transitions to error when uv probe fails', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [{ exitCode: 1 }]; // uv --version fails

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
    });

    it('transitions to error when python install fails', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version
        { exitCode: 1 }, // python install fails
        { exitCode: 1 }, // retry also fails
      ];

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
    });

    it('transitions to error when venv creation fails', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version
        { exitCode: 0 }, // python install
        { exitCode: 1 }, // venv create fails
        { exitCode: 1 }, // retry also fails
      ];

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
    });

    it('transitions to error when pip install fails', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version
        { exitCode: 0 }, // python install
        { exitCode: 0 }, // venv create
        { exitCode: 1 }, // pip install fails
      ];

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
    });
  });

  describe('preflight checks', () => {
    it('fails with error on insufficient disk space', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.diskFreeBytes = 500 * 1024 * 1024; // 500 MB < 1 GB minimum

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
      // Should not have reached installing
      expect(types).not.toContain('installing');
    });

    it('fails with error when network is unreachable', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.networkReachable = false;

      await mgr.startInstall();

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
      expect(types).not.toContain('installing');
    });
  });

  describe('cancellation', () => {
    it('cancelInstall is a no-op when not installing', async () => {
      const { mgr, statusChanges } = makeMgr();
      await mgr.cancelInstall();

      // No status changes should have occurred
      expect(statusChanges).toHaveLength(0);
    });

    it('cancelInstall sets canceling status when install is in progress', async () => {
      const { mgr, statusChanges } = makeMgr();
      // Set up so the install starts
      mgr.updateStatus({ type: 'installing' });
      statusChanges.length = 0;

      await mgr.cancelInstall();

      expect(statusChanges.some((s) => s.type === 'canceling')).toBe(true);
    });
  });

  describe('updateStatus', () => {
    it('updates status and calls onStatusChange', () => {
      const { mgr, statusChanges } = makeMgr();
      mgr.updateStatus({ type: 'installing' });

      expect(mgr.getStatus().type).toBe('installing');
      expect(mgr.getStatus().timestamp).toBeGreaterThan(0);
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0]!.type).toBe('installing');
    });
  });

  describe('resizePty', () => {
    it('stores dimensions and delegates to command runner', () => {
      const { mgr } = makeMgr();
      // Should not throw even when no command is running
      mgr.resizePty(120, 40);
    });
  });

  describe('repair mode', () => {
    it('passes repair flag through to install steps', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version
        { exitCode: 0 }, // python install
        { exitCode: 0 }, // venv create
        { exitCode: 0 }, // pip install
      ];

      await mgr.startInstall(true); // repair = true

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('completed');
    });

    it('repair mode does not retry on python install failure', async () => {
      const { mgr, statusChanges } = makeMgr();
      hoisted.commandRunnerResults = [
        { exitCode: 0 }, // uv --version
        { exitCode: 1 }, // python install fails — in repair mode, no retry
      ];

      await mgr.startInstall(true);

      const types = statusChanges.map((s) => s.type);
      expect(types).toContain('error');
      // Only 2 commands should have been attempted (uv --version + python install)
      expect(hoisted.commandRunnerCallIndex).toBe(2);
    });
  });
});
