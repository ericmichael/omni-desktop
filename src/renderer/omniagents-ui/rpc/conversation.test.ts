import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { ConversationClient, ConversationProtocolError, type ConversationRpcTransport } from './conversation';

type ConversationMethod = Extract<keyof RpcMethodMap, 'get_thread' | 'list_turns' | 'list_items' | 'get_item'>;

const thread = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  thread_id: 'thread-1',
  user_id: null,
  status: 'active',
  title: null,
  created_at: 1,
  updated_at: 2,
  last_seq: 3,
  turn_count: 1,
  item_count: 2,
  parent_thread_id: null,
  branched_from_item_id: null,
  usage: { input_tokens: 5 },
  compaction: {},
  source: 'recorded',
  projected_at: 2,
  schema_version: 1,
  ...overrides,
});

const turn = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  turn_id: 'turn-1',
  thread_id: 'thread-1',
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
  model: 'gpt-5',
  model_ref: 'catalog/gpt-5',
  item_count: 2,
  first_seq: 1,
  last_seq: 2,
  attempts: 0,
  source: 'recorded',
  schema_version: 1,
  ...overrides,
});

const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item_id: 'itm_123',
  thread_id: 'thread-1',
  turn_id: 'turn-1',
  seq: 1,
  kind: 'agent_message',
  status: 'completed',
  role: 'assistant',
  created_at: 1,
  updated_at: 2,
  completed_at: 2,
  revision: 1,
  content: { text: 'hello' },
  source_ref: { event: 'message_output' },
  long_lived: false,
  source: 'recorded',
  schema_version: 1,
  ...overrides,
});

class FakeConversationRpc implements ConversationRpcTransport {
  readonly calls: Array<{ method: ConversationMethod; params: unknown }> = [];
  readonly request = vi.fn(
    async <Method extends ConversationMethod>(
      method: Method,
      params: RpcMethodMap[Method]['params']
    ): Promise<RpcMethodMap[Method]['result']> => {
      this.calls.push({ method, params });
      const result = this.results[method];
      if (result === undefined) {
        throw new Error(`No fake result for ${method}`);
      }
      return result as RpcMethodMap[Method]['result'];
    }
  );

  constructor(private readonly results: Partial<Record<ConversationMethod, unknown>>) {}
}

describe('ConversationClient', () => {
  it('gets a thread, validates its canonical id, and retains additive fields', async () => {
    const rpc = new FakeConversationRpc({
      get_thread: thread({
        pinned: true,
        metadata: { color: 'blue' },
        future_thread_field: { enabled: true },
      }),
    });
    const client = new ConversationClient(rpc);

    const result = await client.getThread('thread-1');

    expect(rpc.calls).toEqual([{ method: 'get_thread', params: { thread_id: 'thread-1' } }]);
    expect(result).toMatchObject({
      thread_id: 'thread-1',
      pinned: true,
      metadata: { color: 'blue' },
      future_thread_field: { enabled: true },
    });
  });

  it('sends complete keyset paging params and decodes turns in requested order', async () => {
    const rpc = new FakeConversationRpc({
      list_turns: {
        thread_id: 'thread-1',
        turns: [turn({ turn_id: 'turn-2', ordinal: 2 }), turn()],
        next_cursor: 'opaque-next',
        has_more: true,
        total: 4,
        future_page_field: 'kept',
      },
    });
    const client = new ConversationClient(rpc);

    const result = await client.listTurns('thread-1', {
      limit: 2,
      cursor: 'opaque-current',
      order: 'desc',
    });

    expect(rpc.calls).toEqual([
      {
        method: 'list_turns',
        params: { thread_id: 'thread-1', limit: 2, cursor: 'opaque-current', order: 'desc' },
      },
    ]);
    expect(result.turns.map(({ turn_id }) => turn_id)).toEqual(['turn-2', 'turn-1']);
    expect(result.future_page_field).toBe('kept');
  });

  it('passes item filters and preserves unknown kinds, content, and additive fields', async () => {
    const rpc = new FakeConversationRpc({
      list_items: {
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        items: [
          item({
            kind: 'future_rich_card',
            content: { blocks: [{ type: 'future-chart', values: [1, 2] }] },
            future_item_field: 42,
          }),
        ],
        next_cursor: null,
        has_more: false,
        total: 1,
      },
    });
    const client = new ConversationClient(rpc);

    const result = await client.listItems('thread-1', {
      turnId: 'turn-1',
      kinds: ['agent_message', 'future_rich_card'],
      limit: -5,
      order: 'asc',
    });

    expect(rpc.calls).toEqual([
      {
        method: 'list_items',
        params: {
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          kinds: ['agent_message', 'future_rich_card'],
          limit: -5,
          order: 'asc',
        },
      },
    ]);
    expect(result.items[0]).toMatchObject({
      kind: 'future_rich_card',
      content: { blocks: [{ type: 'future-chart', values: [1, 2] }] },
      future_item_field: 42,
    });
  });

  it('gets an item using both canonical identifiers', async () => {
    const rpc = new FakeConversationRpc({ get_item: item() });
    const client = new ConversationClient(rpc);

    await expect(client.getItem('thread-1', 'itm_123')).resolves.toMatchObject({
      thread_id: 'thread-1',
      item_id: 'itm_123',
      seq: 1,
      revision: 1,
      status: 'completed',
    });
    expect(rpc.calls).toEqual([{ method: 'get_item', params: { thread_id: 'thread-1', item_id: 'itm_123' } }]);
  });

  it.each([
    ['wrong thread id', thread({ thread_id: 'thread-2' }), /different thread_id/],
    ['unknown thread status', thread({ status: 'deleted' }), /status has unsupported value/],
    ['invalid last seq', thread({ last_seq: -1 }), /last_seq must be a non-negative safe integer/],
  ])('rejects malformed get_thread results: %s', async (_name, payload, message) => {
    const client = new ConversationClient(new FakeConversationRpc({ get_thread: payload }));
    await expect(client.getThread('thread-1')).rejects.toThrow(message);
  });

  it.each([
    ['zero seq', item({ seq: 0 }), /seq must be positive/],
    ['negative revision', item({ revision: -1 }), /revision must be a non-negative safe integer/],
    ['unknown status', item({ status: 'paused' }), /status has unsupported value/],
    ['non-record content', item({ content: ['not', 'an', 'object'] }), /content must be an object/],
    ['wrong item id', item({ item_id: 'itm_other' }), /different canonical identifiers/],
  ])('rejects malformed get_item results: %s', async (_name, payload, message) => {
    const client = new ConversationClient(new FakeConversationRpc({ get_item: payload }));
    await expect(client.getItem('thread-1', 'itm_123')).rejects.toThrow(message);
  });

  it('rejects page entries outside the requested thread or turn', async () => {
    const wrongThread = new ConversationClient(
      new FakeConversationRpc({
        list_turns: {
          thread_id: 'thread-1',
          turns: [turn({ thread_id: 'thread-2' })],
          next_cursor: null,
          has_more: false,
          total: 1,
        },
      })
    );
    await expect(wrongThread.listTurns('thread-1')).rejects.toThrow(/turn for a different thread_id/);

    const wrongTurn = new ConversationClient(
      new FakeConversationRpc({
        list_items: {
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          items: [item({ turn_id: 'turn-2' })],
          next_cursor: null,
          has_more: false,
          total: 1,
        },
      })
    );
    await expect(wrongTurn.listItems('thread-1', { turnId: 'turn-1' })).rejects.toThrow(/item for a different turn_id/);
  });

  it('rejects malformed pagination and non-monotonic canonical ordering', async () => {
    const missingCursor = new ConversationClient(
      new FakeConversationRpc({
        list_items: {
          thread_id: 'thread-1',
          turn_id: null,
          items: [],
          next_cursor: null,
          has_more: true,
          total: 2,
        },
      })
    );
    await expect(missingCursor.listItems('thread-1')).rejects.toThrow(/next_cursor is required/);

    const duplicateSeq = new ConversationClient(
      new FakeConversationRpc({
        list_items: {
          thread_id: 'thread-1',
          turn_id: null,
          items: [item(), item({ item_id: 'itm_456' })],
          next_cursor: null,
          has_more: false,
          total: 2,
        },
      })
    );
    await expect(duplicateSeq.listItems('thread-1')).rejects.toThrow(/strictly ascending/);
  });

  it('validates paging inputs before sending a request', async () => {
    const rpc = new FakeConversationRpc({});
    const client = new ConversationClient(rpc);

    await expect(client.listTurns('', { limit: 1 })).rejects.toThrow(/threadId must be a non-empty string/);
    await expect(client.listTurns('thread-1', { limit: 1.5 })).rejects.toThrow(/limit must be a safe integer/);
    await expect(client.listItems('thread-1', { kinds: [''] })).rejects.toThrow(/kinds\[0\]/);
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it('uses protocol errors for malformed server boundaries', async () => {
    const client = new ConversationClient(new FakeConversationRpc({ get_item: { item_id: 'itm_123' } }));
    await expect(client.getItem('thread-1', 'itm_123')).rejects.toBeInstanceOf(ConversationProtocolError);
  });
});
