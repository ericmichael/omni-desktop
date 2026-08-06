import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';

import { useChatSession } from './use-chat-session';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type HookValue = ReturnType<typeof useChatSession>;

type Deferred = {
  promise: Promise<Record<string, unknown>>;
  resolve: (value: Record<string, unknown>) => void;
};

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<Record<string, unknown>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function page(threadId: string, content: string) {
  return {
    thread_id: threadId,
    turn_id: null,
    items: [
      {
        item_id: `item-${threadId}`,
        thread_id: threadId,
        turn_id: null,
        seq: 1,
        kind: 'user_message',
        status: 'completed',
        role: 'user',
        created_at: 1,
        updated_at: 1,
        completed_at: 1,
        revision: 0,
        content: { text: content },
        source_ref: {},
        long_lived: false,
        source: 'recorded',
        schema_version: 1,
      },
    ],
    next_cursor: null,
    has_more: false,
    total: 1,
  };
}

function fakeClient() {
  const reads = new Map<string, Deferred[]>();
  let resyncHandler: ((sessionId: string) => void) | null = null;
  const client = {
    isConnected: false,
    actor: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    on: vi.fn(() => () => {}),
    onResyncRequired: vi.fn((handler: (sessionId: string) => void) => {
      resyncHandler = handler;
      return () => {
        resyncHandler = null;
      };
    }),
    supportsExperimentalFeature: vi.fn(() => false),
    registerSession: vi.fn(async () => {}),
    unregisterSession: vi.fn(),
    completeSessionResync: vi.fn(async () => {}),
    getSessionHistory: vi.fn(async () => []),
    request: vi.fn((method: string, params: { thread_id?: string }) => {
      if (method !== 'list_items' || !params.thread_id) {
        throw new Error(`unexpected ${method}`);
      }
      const read = deferred();
      const queue = reads.get(params.thread_id) ?? [];
      queue.push(read);
      reads.set(params.thread_id, queue);
      return read.promise;
    }),
    resolveNext(threadId: string, content: string) {
      const read = reads.get(threadId)?.shift();
      if (!read) {
        throw new Error(`no pending read for ${threadId}`);
      }
      read.resolve(page(threadId, content));
    },
    emitResync(sessionId: string) {
      resyncHandler?.(sessionId);
    },
  };
  return client;
}

let container: HTMLDivElement;
let root: Root;
let value: HookValue;

function Harness({ client }: { client: RPCClient }) {
  value = useChatSession(client);
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useChatSession load identity', () => {
  it('drops an older transcript response after the user selects another session', async () => {
    const client = fakeClient();
    await act(async () => root.render(<Harness client={client as unknown as RPCClient} />));

    let loadA!: Promise<string>;
    let loadB!: Promise<string>;
    await act(async () => {
      loadA = value.loadSession('A');
      await flushAsyncWork();
      loadB = value.loadSession('B');
      await flushAsyncWork();
    });
    await act(async () => {
      client.resolveNext('B', 'new session');
      await loadB;
      client.resolveNext('A', 'stale session');
      await loadA;
    });

    expect(value.sessionId).toBe('B');
    expect(value.items).toEqual([expect.objectContaining({ type: 'chat', content: 'new session' })]);
  });

  it('does not complete a stale authoritative resync after navigation', async () => {
    const client = fakeClient();
    await act(async () => root.render(<Harness client={client as unknown as RPCClient} />));

    let initial!: Promise<string>;
    await act(async () => {
      initial = value.loadSession('A');
      await flushAsyncWork();
      client.resolveNext('A', 'initial');
      await initial;
    });

    await act(async () => {
      client.emitResync('A');
      await flushAsyncWork();
      void value.loadSession('B');
      await flushAsyncWork();
      client.resolveNext('B', 'selected');
      await Promise.resolve();
      client.resolveNext('A', 'stale resync');
      await Promise.resolve();
    });

    expect(value.sessionId).toBe('B');
    expect(value.items).toEqual([expect.objectContaining({ content: 'selected' })]);
    expect(client.completeSessionResync).not.toHaveBeenCalledWith('A');
  });
});
