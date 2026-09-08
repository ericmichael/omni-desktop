import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';

import { resetConversation } from './reset-conversation';
import { deferred, fakeSessionClient } from './session-test-support';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('keeps the current conversation and rejects reset when stopping fails', async () => {
  const selectNew = vi.fn();
  const stopRun = vi.fn(async () => {
    throw new Error('stop failed');
  });
  await expect(resetConversation({ runId: 'active', stopRun, selectNew })).rejects.toThrow('stop failed');
  expect(selectNew).not.toHaveBeenCalled();
});

it('waits for successful stop before selecting a new conversation', async () => {
  const stop = deferred<void>();
  const selectNew = vi.fn();
  const resetting = resetConversation({ runId: 'active', stopRun: () => stop.promise, selectNew });
  expect(selectNew).not.toHaveBeenCalled();
  stop.resolve();
  await resetting;
  expect(selectNew).toHaveBeenCalledTimes(1);
});

it('resets an idle conversation without issuing a stop RPC', async () => {
  const selectNew = vi.fn();
  const stopRun = vi.fn();
  await resetConversation({ stopRun, selectNew });
  expect(stopRun).not.toHaveBeenCalled();
  expect(selectNew).toHaveBeenCalledTimes(1);
});

it.each(['direct', 'queued', 'answer'])(
  'does not issue a %s RPC after disposal during a checkpoint save',
  async (kind) => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const { DraftStorage } = await import('@/renderer/omniagents-ui/draft-storage');
    const { ConversationSession } = await import('./conversation-session');
    const { fake, client } = fakeSessionClient();
    const session = new ConversationSession(`dispose-${kind}`, client);
    await session.load();
    if (kind === 'answer') {
      session.dispatch('client_request', {
        session_id: session.id,
        request_id: 'q',
        function: 'escalate',
        args: { message: 'Question' },
      });
    }
    if (kind === 'queued') {
      session.panels.set('queuedMessages', [{ id: 'existing', content: 'queued' }] as any);
    }
    const gate = deferred<void>();
    const original = DraftStorage.prototype.update;
    let waiting = false;
    vi.spyOn(DraftStorage.prototype, 'update').mockImplementation(async function (
      this: InstanceType<typeof DraftStorage>,
      id,
      change
    ) {
      const preview: any = change(undefined);
      if (preview.pendingSubmission) {
        waiting = true;
        await gate.promise;
      }
      return original.call(this, id, change);
    });
    const sending = session.send('keep this unsent');
    await vi.waitFor(() => expect(waiting).toBe(true));
    session.dispose();
    gate.resolve();
    await expect(sending).rejects.toThrow('connecting');
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
    expect(fake.clientResponse).not.toHaveBeenCalled();
  }
);

it.each([false, true])('preserves a losing window’s input across broadcasts (follow-up=%s)', async (followUp) => {
  class Channel {
    static instances: Channel[] = [];
    onmessage?: (event: MessageEvent) => void;
    constructor() {
      Channel.instances.push(this);
    }
    postMessage() {}
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const first = await import('@/renderer/omniagents-ui/conversation-drafts');
  await first.draftsReady;
  vi.resetModules();
  const second = await import('@/renderer/omniagents-ui/conversation-drafts');
  await second.draftsReady;
  first.updateConversationDraft('shared', { text: '', files: [], pendingInput: { text: 'first prompt', files: [] } });
  await first.flushConversationDrafts('shared');
  second.updateConversationDraft('shared', {
    text: '',
    files: [],
    pendingInput: { id: 'second', text: 'second prompt', files: [] },
  });
  await expect(second.flushConversationDrafts('shared')).rejects.toThrow();
  // The composer failure continuation no longer owns the shared checkpoint.
  second.updateConversationDraft('shared', { text: 'second prompt', pendingInput: undefined }, { inputId: 'second' });
  await expect(second.flushConversationDrafts('shared')).rejects.toThrow();
  if (followUp) {
    second.updateConversationDraft('shared', { text: 'follow-up' });
    await second.flushConversationDrafts('shared');
  }
  first.updateConversationDraft('shared', { pendingInput: undefined });
  await first.flushConversationDrafts('shared');
  const authoritativeRevision = first.getConversationDraft('shared').recoveryRevision;
  Channel.instances[1]!.onmessage!(new MessageEvent('message', { data: 'shared' }));
  await vi.waitFor(() => expect(second.getConversationDraft('shared').recoveryRevision).toBe(authoritativeRevision));
  expect(second.getConversationDraft('shared').text).toBe(followUp ? 'follow-up' : '');
  expect(second.getConversationDraft('shared').otherDrafts).toEqual([
    expect.objectContaining({ id: 'second', text: 'second prompt' }),
  ]);
  // The refreshed revision allows a real retry; no reload is required.
  second.updateConversationDraft('shared', { pendingInput: { text: 'second prompt', files: [] } });
  await expect(second.flushConversationDrafts('shared')).resolves.toBeUndefined();
});
