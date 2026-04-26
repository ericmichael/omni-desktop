/**
 * Tests for ConsoleManager — multi-PTY lifecycle, write/resize delegation,
 * disposal, exit callback cleanup, and state queries.
 *
 * Uses injectable deps — zero vi.mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleManagerDeps } from '@/main/console-manager';
import { ConsoleManager } from '@/main/console-manager';

// ---------------------------------------------------------------------------
// Fake PTY
// ---------------------------------------------------------------------------

type FakePty = {
  pid: number;
  onDataCb?: (data: string) => void;
  onExitCb?: (exit: { exitCode: number; signal?: number }) => void;
  writeCalls: string[];
  resizeCalls: Array<{ cols: number; rows: number }>;
  killed: boolean;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (exit: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
};

function makeFakePty(id: number): FakePty {
  const pty: FakePty = {
    pid: 10000 + id,
    writeCalls: [],
    resizeCalls: [],
    killed: false,
    write: (data: string) => { pty.writeCalls.push(data); },
    resize: (cols: number, rows: number) => { pty.resizeCalls.push({ cols, rows }); },
    kill: () => { pty.killed = true; },
    onData: (cb) => { pty.onDataCb = cb; return { dispose: () => {} }; },
    onExit: (cb) => { pty.onExitCb = cb; return { dispose: () => {} }; },
  };
  return pty;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ptyInstances: FakePty[];
let idCounter: number;

function makeDeps(overrides: Partial<ConsoleManagerDeps> = {}): ConsoleManagerDeps {
  return {
    createPty: () => {
      const pty = makeFakePty(ptyInstances.length);
      ptyInstances.push(pty);
      return pty as never;
    },
    createBuffer: () => ({ append: vi.fn(), clear: vi.fn() }) as never,
    setupCallbacks: (ptyProcess: unknown, callbacks: { onData: (d: string) => void; onExit: (code: number, sig?: number) => void }) => {
      const proc = ptyProcess as FakePty;
      proc.onDataCb = callbacks.onData;
      proc.onExitCb = (exit) => callbacks.onExit(exit.exitCode, exit.signal);
    },
    killPty: vi.fn(async () => {}),
    getShell: () => '/bin/sh',
    getHomeDir: () => '/home/test',
    getBinPath: () => '/app/bin',
    getActivateCmd: () => 'source /path/.venv/bin/activate',
    isDir: vi.fn(async () => false),
    newId: () => `console-${++idCounter}`,
    ...overrides,
  } as ConsoleManagerDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleManager', () => {
  beforeEach(() => {
    ptyInstances = [];
    idCounter = 0;
  });

  it('starts with no active consoles', () => {
    const mgr = new ConsoleManager(makeDeps());
    expect(mgr.listIdsForTab('tab-1')).toEqual([]);
    expect(mgr.isActive()).toBe(false);
  });

  it('createConsole returns an id and tracks the entry for its tab', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const id = await mgr.createConsole('tab-1', { onData: vi.fn(), onExit: vi.fn() });

    expect(id).toBe('console-1');
    expect(mgr.listIdsForTab('tab-1')).toEqual(['console-1']);
    expect(mgr.listIdsForTab('tab-2')).toEqual([]);
    expect(mgr.isActive()).toBe(true);
    expect(ptyInstances).toHaveLength(1);
  });

  it('keeps terminals from different tabs isolated', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const callbacks = { onData: vi.fn(), onExit: vi.fn() };

    const id1 = await mgr.createConsole('tab-a', callbacks);
    const id2 = await mgr.createConsole('tab-b', callbacks);

    expect(id1).not.toBe(id2);
    expect(mgr.listIdsForTab('tab-a')).toEqual([id1]);
    expect(mgr.listIdsForTab('tab-b')).toEqual([id2]);
  });

  it('write delegates to the PTY process', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const id = await mgr.createConsole('tab-1', { onData: vi.fn(), onExit: vi.fn() });

    mgr.write(id, 'hello\r');

    expect(ptyInstances[0]!.writeCalls).toContain('hello\r');
  });

  it('write is a no-op for unknown id', () => {
    const mgr = new ConsoleManager(makeDeps());
    mgr.write('nonexistent', 'data');
  });

  it('resize delegates to the PTY process', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const id = await mgr.createConsole('tab-1', { onData: vi.fn(), onExit: vi.fn() });

    mgr.resize(id, 120, 40);

    expect(ptyInstances[0]!.resizeCalls).toContainEqual({ cols: 120, rows: 40 });
  });

  it('resize is a no-op for unknown id', () => {
    const mgr = new ConsoleManager(makeDeps());
    mgr.resize('nonexistent', 80, 24);
  });

  it('disposeOne removes entry and kills PTY', async () => {
    const deps = makeDeps();
    const mgr = new ConsoleManager(deps);
    const id = await mgr.createConsole('tab-1', { onData: vi.fn(), onExit: vi.fn() });

    await mgr.disposeOne(id);

    expect(mgr.listIdsForTab('tab-1')).toEqual([]);
    expect(mgr.isActive()).toBe(false);
    expect(deps.killPty).toHaveBeenCalledOnce();
  });

  it('disposeOne is a no-op for unknown id', async () => {
    const mgr = new ConsoleManager(makeDeps());
    await mgr.disposeOne('nonexistent');
  });

  it('disposeAllForTab removes only that tab\'s entries', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const callbacks = { onData: vi.fn(), onExit: vi.fn() };
    await mgr.createConsole('tab-a', callbacks);
    await mgr.createConsole('tab-a', callbacks);
    const keepId = await mgr.createConsole('tab-b', callbacks);

    await mgr.disposeAllForTab('tab-a');

    expect(mgr.listIdsForTab('tab-a')).toEqual([]);
    expect(mgr.listIdsForTab('tab-b')).toEqual([keepId]);
    expect(mgr.isActive()).toBe(true);
  });

  it('disposeAll removes all entries', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const callbacks = { onData: vi.fn(), onExit: vi.fn() };
    await mgr.createConsole('tab-a', callbacks);
    await mgr.createConsole('tab-b', callbacks);

    expect(mgr.isActive()).toBe(true);

    await mgr.disposeAll();

    expect(mgr.listIdsForTab('tab-a')).toEqual([]);
    expect(mgr.listIdsForTab('tab-b')).toEqual([]);
    expect(mgr.isActive()).toBe(false);
  });

  it('PTY exit callback removes entry from map and notifies with tabId', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const onData = vi.fn();
    const onExit = vi.fn();
    const id = await mgr.createConsole('tab-1', { onData, onExit });

    expect(mgr.isActive()).toBe(true);

    // Simulate the PTY exiting
    ptyInstances[0]!.onExitCb!({ exitCode: 0 });

    expect(mgr.listIdsForTab('tab-1')).toEqual([]);
    expect(mgr.isActive()).toBe(false);
    expect(onExit).toHaveBeenCalledWith('tab-1', id, 0, undefined);
    expect(onData).toHaveBeenCalledWith('tab-1', id, expect.stringContaining('exited with code 0'));
  });

  it('PTY exit with signal includes signal in message', async () => {
    const mgr = new ConsoleManager(makeDeps());
    const onData = vi.fn();
    const onExit = vi.fn();
    await mgr.createConsole('tab-1', { onData, onExit });

    ptyInstances[0]!.onExitCb!({ exitCode: 137, signal: 9 });

    expect(onData).toHaveBeenCalledWith('tab-1', expect.any(String), expect.stringContaining('signal: 9'));
    expect(onExit).toHaveBeenCalledWith('tab-1', expect.any(String), 137, 9);
  });

  it('initializes console with PATH export on creation', async () => {
    const mgr = new ConsoleManager(makeDeps());
    await mgr.createConsole('tab-1', { onData: vi.fn(), onExit: vi.fn() });

    const pathWrite = ptyInstances[0]!.writeCalls.find((w) => w.includes('PATH'));
    expect(pathWrite).toBeDefined();
    expect(pathWrite).toContain('/app/bin');
  });
});
