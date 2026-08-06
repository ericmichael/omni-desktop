import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';

import { useConversationManagement } from './use-conversation-management';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thread = (overrides: Record<string, unknown> = {}) => ({
  thread_id: 'thread-1',
  user_id: null,
  status: 'active',
  title: 'First title',
  created_at: 10,
  updated_at: 20,
  last_seq: 3,
  turn_count: 1,
  item_count: 3,
  parent_thread_id: null,
  branched_from_item_id: null,
  usage: {},
  compaction: {},
  pinned: false,
  metadata: {},
  source: 'recorded',
  projected_at: 20,
  schema_version: 1,
  ...overrides,
});

type HookValue = ReturnType<typeof useConversationManagement>;

let container: HTMLDivElement;
let root: Root;
let value: HookValue;

function Harness({ client, connected }: { client: RPCClient; connected: boolean }) {
  value = useConversationManagement(client, connected);
  return <div>{value.sessions.map((session) => session.title).join(',')}</div>;
}

function fakeClient(supported = true) {
  const listeners = new Set<(payload: unknown) => void>();
  let listedThread = thread();
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'get_thread') {
      return thread({ thread_id: (params as { thread_id: string }).thread_id });
    }
    if (method === 'list_threads') {
      return { threads: [listedThread], next_cursor: null, has_more: false, total: 1 };
    }
    if (method === 'search_threads') {
      return {
        query: (params as { query: string }).query,
        results: [
          {
            thread_id: 'thread-1',
            match_count: 1,
            match_kind: 'title',
            item_id: null,
            turn_id: null,
            seq: null,
            preview: 'matching words',
            thread: thread(),
          },
        ],
        next_cursor: null,
        has_more: false,
        total: 1,
      };
    }
    if (method === 'update_thread') {
      const update = params as { thread_id: string; title?: string; pinned?: boolean; status?: string };
      return {
        thread: thread({
          title: update.title ?? 'First title',
          pinned: update.pinned ?? false,
          status: update.status ?? 'active',
          updated_at: 30,
        }),
        changed: Object.keys(update).filter((key) => key !== 'thread_id'),
        cascaded_thread_ids: [],
        inaccessible_descendant_count: 0,
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  return {
    request,
    listSessions: vi.fn(async () => [
      { id: 'legacy', created_at: new Date(0).toISOString(), archived: false, message_count: 1 },
    ]),
    supportsExperimentalFeature: vi.fn(() => supported),
    supportsExperimentalOperation: vi.fn(() => supported),
    on: vi.fn((_event: string, handler: (payload: unknown) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    setListedThread: (next: Record<string, unknown>) => {
      listedThread = thread(next);
    },
    emitThreadUpdated: (payload: unknown) => listeners.forEach((handler) => handler(payload)),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useConversationManagement', () => {
  it('loads active canonical rows, searches the server, and applies safe mutations', async () => {
    const client = fakeClient();
    await act(async () => {
      root.render(<Harness client={client as unknown as RPCClient} connected />);
      await Promise.resolve();
    });

    expect(client.request).toHaveBeenCalledWith('list_threads', {
      status: 'active',
      limit: 50,
      order: 'desc',
    });
    expect(client.request).toHaveBeenCalledWith('get_thread', { thread_id: 'legacy' });
    expect(value.sessions[0]).toMatchObject({ id: 'thread-1', title: 'First title', pinned: false });

    act(() => value.setSearchQuery('matching'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(client.request).toHaveBeenCalledWith('search_threads', {
      query: 'matching',
      status: 'active',
      limit: 50,
    });
    expect(value.searchResults?.[0]).toMatchObject({ id: 'thread-1', searchPreview: 'matching words' });

    await act(async () => value.renameThread('thread-1', 'Renamed'));
    expect(client.request).toHaveBeenCalledWith('update_thread', { thread_id: 'thread-1', title: 'Renamed' });

    await act(async () => value.archiveThread('thread-1'));
    await act(async () => value.restoreThread('thread-1'));
    expect(client.request).toHaveBeenCalledWith('update_thread', { thread_id: 'thread-1', status: 'archived' });
    expect(client.request).toHaveBeenCalledWith('update_thread', { thread_id: 'thread-1', status: 'active' });
  });

  it('falls back to legacy listing and never exposes canonical mutations when the feature was not negotiated', async () => {
    const client = fakeClient(false);
    await act(async () => {
      root.render(<Harness client={client as unknown as RPCClient} connected />);
      await Promise.resolve();
    });

    expect(client.listSessions).toHaveBeenCalledWith({ limit: 50 });
    expect(value.managementSupported).toBe(false);
    await act(async () => value.archiveThread('legacy'));
    expect(client.request).not.toHaveBeenCalled();

    act(() => value.setSearchQuery('local only'));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(client.request).not.toHaveBeenCalled();
    expect(value.searchResults).toBeNull();
  });

  it('refetches after cross-column thread updates and reconnects', async () => {
    const client = fakeClient();
    await act(async () => {
      root.render(<Harness client={client as unknown as RPCClient} connected />);
      await Promise.resolve();
    });

    client.setListedThread({ title: 'Updated elsewhere', updated_at: 30 });
    await act(async () => {
      client.emitThreadUpdated({
        thread_id: 'thread-1',
        changed: ['title'],
        thread: thread({ title: 'Updated elsewhere', updated_at: 30 }),
        cascaded_thread_ids: [],
      });
      await Promise.resolve();
    });
    expect(value.sessions[0]?.title).toBe('Updated elsewhere');

    await act(async () => root.render(<Harness client={client as unknown as RPCClient} connected={false} />));
    client.setListedThread({ title: 'After reconnect', updated_at: 40 });
    await act(async () => {
      root.render(<Harness client={client as unknown as RPCClient} connected />);
      await Promise.resolve();
    });
    expect(value.sessions[0]?.title).toBe('After reconnect');
  });
});
