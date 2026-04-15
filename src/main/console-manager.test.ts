/**
 * Tests for ConsoleManager — multi-PTY lifecycle, write/resize delegation,
 * disposal, exit callback cleanup, and state queries.
 *
 * Mocks node-pty via the pty-utils seam so no real shell processes spawn.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  let idCounter = 0;
  const ptyInstances: Array<{
    pid: number;
    onDataCb?: (data: string) => void;
    onExitCb?: (exit: { exitCode: number; signal?: number }) => void;
    writeCalls: string[];
    resizeCalls: Array<{ cols: number; rows: number }>;
    killed: boolean;
  }> = [];

  return { idCounter, ptyInstances };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('nanoid', () => ({
  nanoid: () => `console-${++hoisted.idCounter}`,
}));

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));

vi.mock('@/main/util', () => ({
  getShell: () => '/bin/sh',
  getHomeDirectory: () => '/home/test',
  getBundledBinPath: () => '/app/bin',
  isDirectory: vi.fn(async () => false),
  getActivateVenvCommand: vi.fn(() => 'source /path/.venv/bin/activate'),
}));

vi.mock('@/lib/pty-utils', () => ({
  createPtyProcess: vi.fn(() => {
    const instance = {
      pid: 10000 + hoisted.ptyInstances.length,
      onDataCb: undefined as ((data: string) => void) | undefined,
      onExitCb: undefined as ((exit: { exitCode: number; signal?: number }) => void) | undefined,
      writeCalls: [] as string[],
      resizeCalls: [] as Array<{ cols: number; rows: number }>,
      killed: false,
      // IPty interface methods
      write: (data: string) => {
        instance.writeCalls.push(data);
      },
      resize: (cols: number, rows: number) => {
        instance.resizeCalls.push({ cols, rows });
      },
      kill: () => {
        instance.killed = true;
      },
      onData: (cb: (data: string) => void) => {
        instance.onDataCb = cb;
        return { dispose: vi.fn() };
      },
      onExit: (cb: (exit: { exitCode: number; signal?: number }) => void) => {
        instance.onExitCb = cb;
        return { dispose: vi.fn() };
      },
    };
    hoisted.ptyInstances.push(instance);
    return instance;
  }),
  createPtyBuffer: vi.fn(() => ({
    append: vi.fn(),
    clear: vi.fn(),
  })),
  setupPtyCallbacks: vi.fn((ptyProcess: unknown, callbacks: { onData: (d: string) => void; onExit: (code: number, sig?: number) => void }) => {
    const proc = ptyProcess as (typeof hoisted.ptyInstances)[0];
    proc.onDataCb = callbacks.onData;
    proc.onExitCb = (exit: { exitCode: number; signal?: number }) => callbacks.onExit(exit.exitCode, exit.signal);
  }),
  killPtyProcessAsync: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { ConsoleManager } from '@/main/console-manager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleManager', () => {
  beforeEach(() => {
    hoisted.idCounter = 0;
    hoisted.ptyInstances = [];
  });

  it('starts with no active consoles', () => {
    const mgr = new ConsoleManager();
    expect(mgr.listIds()).toEqual([]);
    expect(mgr.isActive()).toBe(false);
  });

  it('createConsole returns an id and tracks the entry', async () => {
    const mgr = new ConsoleManager();
    const onData = vi.fn();
    const onExit = vi.fn();

    const id = await mgr.createConsole({ onData, onExit });

    expect(id).toBe('console-1');
    expect(mgr.listIds()).toEqual(['console-1']);
    expect(mgr.isActive()).toBe(true);
    expect(hoisted.ptyInstances).toHaveLength(1);
  });

  it('creates multiple independent consoles', async () => {
    const mgr = new ConsoleManager();
    const callbacks = { onData: vi.fn(), onExit: vi.fn() };

    const id1 = await mgr.createConsole(callbacks);
    const id2 = await mgr.createConsole(callbacks);

    expect(id1).not.toBe(id2);
    expect(mgr.listIds()).toHaveLength(2);
    expect(hoisted.ptyInstances).toHaveLength(2);
  });

  it('write delegates to the PTY process', async () => {
    const mgr = new ConsoleManager();
    const id = await mgr.createConsole({ onData: vi.fn(), onExit: vi.fn() });

    mgr.write(id, 'hello\r');

    const proc = hoisted.ptyInstances[0]!;
    // The init sequence writes PATH setup, then our write
    expect(proc.writeCalls).toContain('hello\r');
  });

  it('write is a no-op for unknown id', async () => {
    const mgr = new ConsoleManager();
    // Should not throw
    mgr.write('nonexistent', 'data');
  });

  it('resize delegates to the PTY process', async () => {
    const mgr = new ConsoleManager();
    const id = await mgr.createConsole({ onData: vi.fn(), onExit: vi.fn() });

    mgr.resize(id, 120, 40);

    expect(hoisted.ptyInstances[0]!.resizeCalls).toContainEqual({ cols: 120, rows: 40 });
  });

  it('resize is a no-op for unknown id', () => {
    const mgr = new ConsoleManager();
    mgr.resize('nonexistent', 80, 24);
  });

  it('disposeOne removes entry and kills PTY', async () => {
    const mgr = new ConsoleManager();
    const id = await mgr.createConsole({ onData: vi.fn(), onExit: vi.fn() });

    await mgr.disposeOne(id);

    expect(mgr.listIds()).toEqual([]);
    expect(mgr.isActive()).toBe(false);
  });

  it('disposeOne is a no-op for unknown id', async () => {
    const mgr = new ConsoleManager();
    await mgr.disposeOne('nonexistent'); // should not throw
  });

  it('disposeAll removes all entries', async () => {
    const mgr = new ConsoleManager();
    const callbacks = { onData: vi.fn(), onExit: vi.fn() };
    await mgr.createConsole(callbacks);
    await mgr.createConsole(callbacks);

    expect(mgr.listIds()).toHaveLength(2);

    await mgr.disposeAll();

    expect(mgr.listIds()).toEqual([]);
    expect(mgr.isActive()).toBe(false);
  });

  it('PTY exit callback removes entry from map and notifies', async () => {
    const mgr = new ConsoleManager();
    const onData = vi.fn();
    const onExit = vi.fn();
    const id = await mgr.createConsole({ onData, onExit });

    expect(mgr.isActive()).toBe(true);

    // Simulate the PTY exiting
    const proc = hoisted.ptyInstances[0]!;
    proc.onExitCb!({ exitCode: 0 });

    // Entry should be removed
    expect(mgr.listIds()).toEqual([]);
    expect(mgr.isActive()).toBe(false);

    // Callbacks should have been called
    expect(onExit).toHaveBeenCalledWith(id, 0, undefined);
    // onData should also get exit message
    expect(onData).toHaveBeenCalledWith(id, expect.stringContaining('exited with code 0'));
  });

  it('PTY exit with signal includes signal in message', async () => {
    const mgr = new ConsoleManager();
    const onData = vi.fn();
    const onExit = vi.fn();
    await mgr.createConsole({ onData, onExit });

    hoisted.ptyInstances[0]!.onExitCb!({ exitCode: 137, signal: 9 });

    expect(onData).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('signal: 9'));
    expect(onExit).toHaveBeenCalledWith(expect.any(String), 137, 9);
  });

  it('initializes console with PATH export on creation', async () => {
    const mgr = new ConsoleManager();
    await mgr.createConsole({ onData: vi.fn(), onExit: vi.fn() });

    const proc = hoisted.ptyInstances[0]!;
    // Should have written PATH export
    const pathWrite = proc.writeCalls.find((w) => w.includes('PATH'));
    expect(pathWrite).toBeDefined();
    expect(pathWrite).toContain('/app/bin');
  });
});
