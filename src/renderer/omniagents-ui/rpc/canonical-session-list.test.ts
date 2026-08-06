import { describe, expect, it, vi } from 'vitest';

import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import {
  type CanonicalSessionListTransport,
  loadCanonicalSessionList,
  threadToSessionSummary,
} from './canonical-session-list';

const thread = (overrides: Record<string, unknown> = {}) => ({
  thread_id: 'thread-1',
  user_id: null,
  status: 'active',
  title: 'Canonical title',
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

describe('canonical session list', () => {
  it('adapts canonical identity, status, title, counts, and timestamps', () => {
    expect(threadToSessionSummary(thread() as never)).toEqual({
      id: 'thread-1',
      created_at: '1970-01-01T00:00:10.000Z',
      archived: false,
      message_count: 3,
      title: 'Canonical title',
      pinned: false,
      first_message: { content: 'Canonical title' },
      last_message: { timestamp: '1970-01-01T00:00:20.000Z' },
    });
  });

  it('does not rematerialize legacy identities already present canonically', async () => {
    const transport = {
      request: vi.fn(async (method: string) =>
        method === 'get_thread' ? thread() : { threads: [thread()], next_cursor: null, has_more: false, total: 1 }
      ),
      on: vi.fn(() => () => {}),
      listSessions: vi
        .fn()
        .mockResolvedValue([{ id: 'thread-1', created_at: 'now', archived: false, message_count: 3 }]),
    } as unknown as CanonicalSessionListTransport;

    await expect(loadCanonicalSessionList(transport, 50)).resolves.toHaveLength(1);
    expect(transport.listSessions).toHaveBeenCalledWith({ limit: 50 });
    expect(transport.request).not.toHaveBeenCalledWith('get_thread', { thread_id: 'thread-1' });
    expect(transport.request).toHaveBeenCalledWith('list_threads', { limit: 50, order: 'desc' });
  });

  it('retains a legacy row when its bounded materialization fails', async () => {
    const legacy = [
      { id: 'thread-1', created_at: 'now', archived: false, message_count: 3 },
      { id: 'legacy-only', created_at: 'then', archived: false, message_count: 1 },
    ];
    const transport = {
      request: vi.fn(async (method: string, params: { thread_id?: string }) => {
        if (method === 'get_thread') {
          if (params.thread_id === 'legacy-only') {
            throw new Error('temporary projection failure');
          }
          return thread();
        }
        return { threads: [thread()], next_cursor: null, has_more: false, total: 1 };
      }),
      on: vi.fn(() => () => {}),
      listSessions: vi.fn().mockResolvedValue(legacy),
    } as unknown as CanonicalSessionListTransport;

    await expect(loadCanonicalSessionList(transport, 2, { status: 'active' })).resolves.toEqual([
      expect.objectContaining({ id: 'thread-1', title: 'Canonical title' }),
      legacy[1],
    ]);
    expect(transport.request).toHaveBeenCalledWith('list_threads', {
      status: 'active',
      limit: 2,
      order: 'desc',
    });
  });

  it('falls back only for an explicit unsupported operation', async () => {
    const legacy = [{ id: 'legacy', created_at: 'now', archived: false, message_count: 1 }];
    const transport = {
      request: vi.fn().mockRejectedValue(new OmniagentsRpcError({ code: -32601, message: 'missing' })),
      on: vi.fn(() => () => {}),
      listSessions: vi.fn().mockResolvedValue(legacy),
    } as unknown as CanonicalSessionListTransport;

    await expect(loadCanonicalSessionList(transport, 10)).resolves.toEqual(legacy);
    expect(transport.listSessions).toHaveBeenCalledWith({ limit: 10 });

    (transport.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network failed'));
    await expect(loadCanonicalSessionList(transport, 10)).rejects.toThrow('network failed');
  });
});
