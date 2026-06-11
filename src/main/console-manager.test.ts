/**
 * Smoke test for the proxy-based ConsoleManager. The heavy lifting lives in
 * :class:`TerminalProxy` (WebSocket + JSON-RPC against `omni serve`); this
 * test only verifies that `createConsoleManager` wires the IPC handlers and
 * routes them into the proxy, and that `ConsoleError` is surfaced as a
 * tagged Error so the renderer can distinguish `process_not_ready`.
 */
import { describe, expect, it, vi } from 'vitest';

import { ConsoleManager, createConsoleManager } from '@/main/console-manager';
import type { ProcessManager } from '@/main/process-manager';
import { ConsoleError } from '@/main/terminal-proxy';

const noopProcessManager = {
  getStatus: () => ({ type: 'uninitialized' as const, timestamp: Date.now() }),
} as unknown as ProcessManager;

describe('ConsoleManager', () => {
  it('rejects createConsole when the agent process is not ready', async () => {
    const sendToWindow = vi.fn();
    const ipc = { handle: vi.fn() };
    createConsoleManager({
      ipc: ipc as never,
      sendToWindow,
      processManager: noopProcessManager,
    });

    const createCall = ipc.handle.mock.calls.find((c) => c[0] === 'terminal:create');
    expect(createCall).toBeDefined();
    const handler = createCall![1] as (...args: unknown[]) => Promise<unknown>;

    await expect(handler({}, 'tab-1', undefined)).rejects.toMatchObject({
      message: expect.stringContaining('[process_not_ready]'),
    });
  });

  it('listIdsForTab returns an empty array when nothing is open', () => {
    const proxy = {
      create: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      disposeAll: vi.fn().mockResolvedValue(undefined),
      disposeAllForTab: vi.fn().mockResolvedValue(undefined),
      listIdsForTab: vi.fn(() => []),
    } as never;
    const manager = new ConsoleManager(proxy);
    expect(manager.listIdsForTab('tab-1')).toEqual([]);
  });

  it('exports ConsoleError so the renderer can type-check the kind tag', () => {
    const err = new ConsoleError('process_not_ready', 'oops');
    expect(err.kind).toBe('process_not_ready');
    expect(err.message).toBe('oops');
  });
});
