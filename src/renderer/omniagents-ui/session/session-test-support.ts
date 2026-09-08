import { vi } from 'vitest';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function historyPage(id: string, text: string) {
  return {
    thread_id: id,
    turn_id: null,
    next_cursor: null,
    has_more: false,
    total: text ? 1 : 0,
    items: text
      ? [
          {
            item_id: `item-${id}`,
            thread_id: id,
            turn_id: null,
            seq: 1,
            kind: 'user_message',
            status: 'completed',
            role: 'user',
            created_at: 1,
            updated_at: 1,
            completed_at: 1,
            revision: 0,
            content: { text },
            source_ref: {},
            long_lived: false,
            source: 'recorded',
            schema_version: 1,
          },
        ]
      : [],
  };
}

export function fakeSessionClient() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  const connections = new Set<() => void>();
  const resyncs = new Set<(id: string) => void>();
  const fake = {
    retainedListenerCount: () =>
      connections.size + resyncs.size + [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0),
    isConnected: true,
    actor: {
      subscribe: vi.fn((fn: () => void) => {
        connections.add(fn);
        return { unsubscribe: () => connections.delete(fn) };
      }),
    },
    on: vi.fn((name: string, fn: (payload: any) => void) => {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(fn);
      listeners.set(name, callbacks);
      return () => callbacks.delete(fn);
    }),
    onResyncRequired: vi.fn((fn: (id: string) => void) => {
      resyncs.add(fn);
      return () => resyncs.delete(fn);
    }),
    supportsExperimentalFeature: vi.fn(() => false),
    registerSession: vi.fn(async () => {}),
    unregisterSession: vi.fn(),
    completeSessionResync: vi.fn(async () => {}),
    getSessionHistory: vi.fn(async () => []),
    request: vi.fn(async (method: string, params: any): Promise<any> => {
      if (method === 'list_items') {
        return historyPage(params.thread_id, '');
      }
      if (method === 'queue_status') {
        return { run_active: false };
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
    listQueue: vi.fn(async (): Promise<any> => ({ items: [] })),
    listServerFunctions: vi.fn(async () => [{ name: 'recap' }, { name: 'help' }]),
    serverCall: vi.fn(
      async (_name: string, _args?: any, _id?: string, _target?: any): Promise<any> => ({ snapshot: null })
    ),
    clientResponse: vi.fn(async () => ({ ok: true })),
    startRun: vi.fn(async () => ({ run_id: 'new-run' })),
    stopRun: vi.fn(async (_runId: string) => ({})),
    enqueueMessage: vi.fn(async () => ({ ok: true, reason: undefined as string | undefined })),
    disconnect: vi.fn(),
    emit(name: string, payload: any) {
      for (const fn of listeners.get(name) ?? []) {
        fn(payload);
      }
    },
    connection(connected: boolean) {
      fake.isConnected = connected;
      for (const fn of connections) {
        fn();
      }
    },
    resync(id: string) {
      for (const fn of resyncs) {
        fn(id);
      }
    },
  };
  return { fake, client: fake as unknown as RPCClient };
}
