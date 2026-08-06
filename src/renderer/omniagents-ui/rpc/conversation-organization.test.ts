import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, ThreadUpdatedParams } from '@/generated/omniagents-gui-v1/gui-v1';

import {
  CONVERSATION_ORGANIZATION_SCHEMA_LIMITATIONS,
  ConversationOrganizationClient,
  ConversationOrganizationProtocolError,
  type ConversationOrganizationTransport,
} from './conversation-organization';

type Method =
  | 'list_threads'
  | 'search_threads'
  | 'update_thread'
  | 'list_thread_descendants'
  | 'fork_session'
  | 'export_thread'
  | 'purge_threads';

class FakeTransport implements ConversationOrganizationTransport {
  result: Record<string, unknown> = {};
  readonly calls: Array<{ method: Method; params: unknown }> = [];
  private handler: ((payload: ThreadUpdatedParams) => void) | null = null;

  async request<Requested extends Method>(
    method: Requested,
    params: RpcMethodMap[Requested]['params']
  ): Promise<RpcMethodMap[Requested]['result']> {
    this.calls.push({ method, params });
    return this.result;
  }

  on(_event: 'thread_updated', handler: (payload: ThreadUpdatedParams) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(payload: ThreadUpdatedParams): void {
    this.handler?.(payload);
  }
}

const thread = (id: string, updatedAt: number, overrides: Record<string, unknown> = {}) => ({
  thread_id: id,
  user_id: 'user-1',
  status: 'active',
  title: `Thread ${id}`,
  created_at: 1,
  updated_at: updatedAt,
  last_seq: 2,
  turn_count: 1,
  item_count: 2,
  parent_thread_id: null,
  branched_from_item_id: null,
  usage: {},
  compaction: {},
  pinned: false,
  metadata: {},
  source: 'recorded',
  projected_at: null,
  schema_version: 1,
  loaded: true,
  active: false,
  pending_attention: 0,
  attention: { tool_approvals: 0 },
  ...overrides,
});

const turn = (threadId = 'thread-1') => ({
  turn_id: 'turn-1',
  thread_id: threadId,
  ordinal: 1,
  status: 'completed',
  created_at: 1,
  updated_at: 2,
  completed_at: 2,
  prompt: 'hello',
  prompt_role: 'user',
  end_reason: 'completed',
  error: null,
  usage: {},
  model: null,
  model_ref: null,
  item_count: 1,
  first_seq: 1,
  last_seq: 1,
  attempts: 1,
  source: 'recorded',
  schema_version: 1,
});

const item = (seq: number, threadId = 'thread-1') => ({
  item_id: `item-${seq}`,
  thread_id: threadId,
  turn_id: 'turn-1',
  seq,
  kind: 'agent_message',
  status: 'completed',
  role: 'assistant',
  created_at: seq,
  updated_at: seq,
  completed_at: seq,
  revision: 0,
  content: { text: `message ${seq}` },
  source_ref: {},
  long_lived: false,
  source: 'recorded',
  schema_version: 1,
});

describe('ConversationOrganizationClient reads and mutations', () => {
  it('validates keyset ordering, forwards filters, and preserves additive listing fields', async () => {
    const rpc = new FakeTransport();
    rpc.result = {
      threads: [thread('thread-b', 10, { future_thread: true }), thread('thread-a', 10)],
      next_cursor: 'opaque-cursor',
      has_more: true,
      total: 3,
      server_hint: 'future',
    };
    const client = new ConversationOrganizationClient(rpc);

    const result = await client.listThreads({
      status: 'active',
      pinned: true,
      model: 'gpt-test',
      updatedAfter: 5,
      limit: 2,
      order: 'desc',
    });

    expect(rpc.calls[0]).toEqual({
      method: 'list_threads',
      params: { status: 'active', pinned: true, model: 'gpt-test', updated_after: 5, limit: 2, order: 'desc' },
    });
    expect(result).toMatchObject({ next_cursor: 'opaque-cursor', has_more: true, server_hint: 'future' });
    expect(result.threads[0]).toMatchObject({ thread_id: 'thread-b', future_thread: true, loaded: true });
    expect(client.getCached('thread-b')).toEqual(result.threads[0]);
    client.dispose();
  });

  it('keeps ranked search order and validates the canonical thread embedded in every hit', async () => {
    const rpc = new FakeTransport();
    rpc.result = {
      query: 'parser bug',
      results: [
        {
          thread_id: 'thread-2',
          match_count: 4,
          match_kind: 'tool_call',
          item_id: 'item-4',
          turn_id: 'turn-2',
          seq: 9,
          preview: 'fixed parser bug',
          thread: thread('thread-2', 7),
          rank_detail: 0.9,
        },
      ],
      next_cursor: null,
      has_more: false,
      total: 1,
    };
    const client = new ConversationOrganizationClient(rpc);

    const result = await client.searchThreads('parser bug', { cursor: 'offset-cursor', limit: 10 });

    expect(rpc.calls[0]).toEqual({
      method: 'search_threads',
      params: { query: 'parser bug', limit: 10, cursor: 'offset-cursor' },
    });
    expect(result.results[0]).toMatchObject({ rank_detail: 0.9, thread: { thread_id: 'thread-2' } });
    client.dispose();
  });

  it('updates metadata, invalidates cascades, and converges thread_updated by updated_at', async () => {
    const rpc = new FakeTransport();
    const client = new ConversationOrganizationClient(rpc);
    rpc.result = { threads: [thread('child-1', 2)], next_cursor: null, has_more: false, total: 1 };
    await client.listThreads();

    rpc.result = {
      thread: thread('thread-1', 10, { title: 'Renamed', metadata: { color: 'blue' }, additive: true }),
      changed: ['title', 'metadata'],
      cascaded_thread_ids: ['child-1'],
      inaccessible_descendant_count: 2,
    };
    const result = await client.updateThread('thread-1', { title: 'Renamed', metadata: { color: 'blue' } });

    expect(rpc.calls.at(-1)).toEqual({
      method: 'update_thread',
      params: { thread_id: 'thread-1', title: 'Renamed', metadata: { color: 'blue' } },
    });
    expect(result.thread).toMatchObject({ additive: true, title: 'Renamed' });
    expect(client.isInvalidated('child-1')).toBe(true);
    expect(client.getCached('child-1')).toBeUndefined();

    const updates = vi.fn();
    client.onThreadUpdated(updates);
    rpc.emit({
      thread_id: 'thread-1',
      changed: ['title'],
      thread: thread('thread-1', 9, { title: 'Stale' }),
      cascaded_thread_ids: [],
    });
    rpc.emit({
      thread_id: 'thread-1',
      changed: ['title'],
      thread: thread('thread-1', 11, { title: 'Newest', notification_field: 'kept' }),
      cascaded_thread_ids: ['child-2'],
      stream_id: 'additive-envelope',
    });

    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]?.[0]).toMatchObject({ stream_id: 'additive-envelope' });
    expect(client.getCached('thread-1')).toMatchObject({ title: 'Newest', notification_field: 'kept' });
    expect(client.isInvalidated('child-2')).toBe(true);
    client.dispose();
  });

  it('validates ancestry and exact fork-point requests without inventing workspace behavior', async () => {
    const rpc = new FakeTransport();
    const client = new ConversationOrganizationClient(rpc);
    rpc.result = {
      thread_id: 'thread-1',
      parent_thread_id: 'parent-1',
      branched_from_item_id: 'item-parent',
      descendants: [thread('child-1', 5, { depth: 1, child_hint: true })],
      max_depth: 4,
      truncated: true,
    };

    const descendants = await client.listThreadDescendants('thread-1', { maxDepth: 4, limit: 20 });
    expect(rpc.calls[0]).toEqual({
      method: 'list_thread_descendants',
      params: { thread_id: 'thread-1', max_depth: 4, limit: 20 },
    });
    expect(descendants).toMatchObject({ truncated: true, descendants: [{ depth: 1, child_hint: true }] });

    rpc.result = {
      session_id: 'thread-1',
      new_session_id: 'thread-child',
      branched_from_item_id: 'item-8',
      copy_mode: 'prefix',
    };
    const forked = await client.forkSession('thread-1', {
      newSessionId: 'thread-child',
      fromTurnId: 'turn-8',
    });
    expect(rpc.calls.at(-1)).toEqual({
      method: 'fork_session',
      params: { session_id: 'thread-1', new_session_id: 'thread-child', from_turn_id: 'turn-8' },
    });
    expect(forked).toMatchObject({ branched_from_item_id: 'item-8', copy_mode: 'prefix' });
    await expect(client.forkSession('thread-1', { fromItemId: 'item-1', fromTurnId: 'turn-1' })).rejects.toThrow(
      /either fromItemId or fromTurnId/
    );
    client.dispose();
  });

  it('preserves export cursor order and validates purge preview/results', async () => {
    const rpc = new FakeTransport();
    const client = new ConversationOrganizationClient(rpc);
    rpc.result = {
      thread: thread('thread-1', 8),
      turns: [turn()],
      items: [item(1), item(2)],
      next_cursor: 'item-cursor',
      has_more: true,
      turns_truncated: false,
      descendant_thread_ids: ['child-1'],
      descendants_truncated: true,
      export_version: 2,
    };

    const exported = await client.exportThread('thread-1', {
      limit: 2,
      cursor: 'previous-cursor',
      includeDescendants: true,
    });
    expect(rpc.calls[0]).toEqual({
      method: 'export_thread',
      params: { thread_id: 'thread-1', limit: 2, cursor: 'previous-cursor', include_descendants: true },
    });
    expect(exported).toMatchObject({ export_version: 2, items: [{ seq: 1 }, { seq: 2 }] });

    rpc.result = { purged_thread_ids: ['old-1', 'old-2'], count: 2, dry_run: true, cutoff: 123 };
    const preview = await client.purgeThreads(30, true);
    expect(rpc.calls.at(-1)).toEqual({ method: 'purge_threads', params: { retention_days: 30, dry_run: true } });
    expect(preview).toMatchObject({ count: 2, dry_run: true, cutoff: 123 });
    client.dispose();
  });

  it('documents generated-schema gaps and rejects malformed cursor/order payloads', async () => {
    expect(CONVERSATION_ORGANIZATION_SCHEMA_LIMITATIONS.join(' ')).toContain('title:null');
    expect(CONVERSATION_ORGANIZATION_SCHEMA_LIMITATIONS.join(' ')).toContain('no revision');

    const rpc = new FakeTransport();
    rpc.result = {
      threads: [thread('thread-a', 1), thread('thread-b', 2)],
      next_cursor: null,
      has_more: true,
      total: 2,
    };
    const client = new ConversationOrganizationClient(rpc);
    await expect(client.listThreads({ order: 'desc' })).rejects.toBeInstanceOf(ConversationOrganizationProtocolError);
    client.dispose();
  });
});
