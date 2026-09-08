import { expect, it, vi } from 'vitest';

import { ConversationSession } from './conversation-session';
import { deferred, fakeSessionClient, historyPage } from './session-test-support';

it.each(['new-run', 'rehydrated', 'closed'])('keeps delayed canonical output scoped after %s', async (boundary) => {
  const { fake, client } = fakeSessionClient();
  const owner = new ConversationSession('delayed-owner', client);
  const other = new ConversationSession('other-tile', client);
  let replacement: ConversationSession | undefined;
  try {
    await Promise.all([owner.load(), other.load()]);
    const item = {
      ...historyPage(owner.id, 'old-run answer').items[0]!,
      kind: 'agent_message',
      role: 'assistant',
      turn_id: 'old-run',
      content: { text: 'old-run answer', message_id: 'msg_old' },
      source_ref: { event: 'message_output', message_id: 'msg_old' },
    };
    const gate = deferred<typeof item>();
    const originalRequest = fake.request.getMockImplementation()!;
    fake.request.mockImplementation((method, params) =>
      method === 'get_item' ? gate.promise : originalRequest(method, params)
    );
    fake.supportsExperimentalFeature.mockReturnValue(true);
    owner.dispatch('run_started', { session_id: owner.id, run_id: 'old-run' });
    owner.dispatch('item_updated', {
      session_id: owner.id,
      thread_id: owner.id,
      item_id: item.item_id,
      kind: item.kind,
    });
    await vi.waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith('get_item', { thread_id: owner.id, item_id: item.item_id })
    );
    if (boundary === 'closed') {
      owner.dispose();
      replacement = new ConversationSession(owner.id, client);
      await replacement.load();
    } else if (boundary === 'new-run') {
      owner.dispatch('run_end', { session_id: owner.id, run_id: 'old-run' });
      owner.dispatch('run_started', { session_id: owner.id, run_id: 'new-run' });
    } else {
      fake.request.mockImplementation((method, params) =>
        method === 'list_items'
          ? Promise.resolve({
              ...historyPage(owner.id, 'old-run answer'),
              items: [{ ...item, revision: 2, updated_at: 3 }],
            })
          : method === 'get_item'
            ? gate.promise
            : originalRequest(method, params)
      );
      await owner.load({ force: true });
    }
    gate.resolve(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(other.actor.getSnapshot().context.items).toHaveLength(0);
    if (boundary === 'closed') {
      expect(owner.actor.getSnapshot().context.items).toHaveLength(0);
      expect(replacement!.actor.getSnapshot().context.items).toHaveLength(0);
    } else {
      const items = owner.actor.getSnapshot().context.items;
      expect(items).toHaveLength(1);
      expect(items[0]?.canonical?.turn_id).toBe('old-run');
      if (boundary === 'rehydrated') {
        expect(items[0]?.canonical?.revision).toBe(2);
      } else {
        expect(owner.actor.getSnapshot().context.runId).toBe('new-run');
      }
    }
  } finally {
    owner.dispose();
    other.dispose();
    replacement?.dispose();
  }
});

it.each(['persistence-first', 'stream-first', 'no-stream'])(
  'merges persisted provider output in its own tile: %s',
  async (order) => {
    const { fake, client } = fakeSessionClient();
    const owner = new ConversationSession('owner', client);
    const other = new ConversationSession('other', client);
    try {
      await Promise.all([owner.load(), other.load()]);
      fake.supportsExperimentalFeature.mockReturnValue(true);
      const item = {
        ...historyPage(owner.id, 'saved answer').items[0]!,
        kind: 'agent_message',
        role: 'assistant',
        turn_id: 'run_saved',
        content: { text: 'saved answer', message_id: 'msg_saved' },
        source_ref: { event: 'message_output', message_id: 'msg_saved' },
      };
      fake.request.mockResolvedValue(item);
      owner.dispatch('run_started', { session_id: owner.id, run_id: 'run_saved' });
      const stream = { session_id: owner.id, run_id: 'run_saved', content: 'saved answer', message_id: 'msg_saved' };
      if (order === 'stream-first') {
        owner.dispatch('message_output', stream);
      }
      const event = { session_id: owner.id, thread_id: owner.id, item_id: item.item_id, kind: item.kind };
      other.dispatch('item_updated', event);
      owner.dispatch('item_updated', event);
      await vi.waitFor(() => expect(owner.actor.getSnapshot().context.items[0]?.canonical?.item_id).toBe(item.item_id));
      if (order !== 'no-stream') {
        owner.dispatch('message_output', stream);
      }
      expect(owner.actor.getSnapshot().context.items).toHaveLength(1);
      expect(other.actor.getSnapshot().context.items).toHaveLength(0);
      // Identical words from distinct provider messages are not duplicates.
      owner.dispatch('message_output', { ...stream, message_id: 'msg_second' });
      expect(owner.actor.getSnapshot().context.items).toHaveLength(2);
    } finally {
      owner.dispose();
      other.dispose();
    }
  }
);

it('adopts queued canonical messages live once and only in their owning session', async () => {
  const { fake, client } = fakeSessionClient();
  const session = new ConversationSession('queue-owner', client);
  try {
    await session.load();
    fake.supportsExperimentalFeature.mockReturnValue(true);
    const item = { ...historyPage(session.id, 'injected message').items[0]!, source_ref: { event: 'enqueue_message' } };
    fake.request.mockImplementation(async (method) => {
      if (method === 'get_item') {
        return item;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const event = { session_id: session.id, thread_id: session.id, item_id: item.item_id, kind: item.kind };
    fake.request.mockResolvedValueOnce({ ...item, thread_id: 'other' });
    session.dispatch('item_updated', event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.actor.getSnapshot().context.items).toHaveLength(0);
    session.dispatch('item_updated', { ...event, thread_id: 'other' });
    expect(session.actor.getSnapshot().context.items).toHaveLength(0);
    session.dispatch('item_updated', event);
    await vi.waitFor(() => expect(session.actor.getSnapshot().context.items).toHaveLength(1));
    fake.request.mockClear();
    session.dispatch('item_updated', event);
    await vi.waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith('get_item', { thread_id: session.id, item_id: item.item_id })
    );
    expect(session.actor.getSnapshot().context.items).toHaveLength(1);
    const duplicateStreamItem = { ...item, item_id: 'ordinary-run-message', source_ref: { event: 'run_started' } };
    fake.request.mockResolvedValueOnce(duplicateStreamItem);
    session.dispatch('item_updated', { ...event, item_id: duplicateStreamItem.item_id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.actor.getSnapshot().context.items).toHaveLength(1);
  } finally {
    session.dispose();
  }
});
