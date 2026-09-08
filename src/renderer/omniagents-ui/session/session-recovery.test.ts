import { afterEach, expect, it, vi } from 'vitest';

import { getConversationDraft } from '@/renderer/omniagents-ui/conversation-drafts';
import { ClientRequestNotPendingError } from '@/renderer/omniagents-ui/rpc/client-response-error';

import { ConversationSession } from './conversation-session';
import { fakeSessionClient } from './session-test-support';

const sessions: ConversationSession[] = [];
function setup(id: string) {
  const { fake, client } = fakeSessionClient();
  const session = new ConversationSession(id, client);
  sessions.push(session);
  return { fake, client, session };
}
afterEach(() => sessions.splice(0).forEach((session) => session.dispose()));

it('uses the original question receipt after a lost acknowledgement, never the newer question', async () => {
  const { fake, session } = setup('question-receipt');
  await session.load();
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'old',
    function: 'escalate',
    args: { message: 'Old question' },
  });
  fake.clientResponse.mockRejectedValueOnce(new Error('ack lost'));
  await expect(session.send('original answer')).rejects.toThrow('ack lost');
  session.dispatch('client_request_resolved', { session_id: session.id, request_id: 'old' });
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'new',
    function: 'escalate',
    args: { message: 'New question' },
  });
  await session.send('original answer');
  expect(fake.clientResponse).toHaveBeenCalledTimes(2);
  expect(fake.clientResponse.mock.calls[0]).toEqual(fake.clientResponse.mock.calls[1]);
  expect(session.panels.state.get().escalation?.request_id).toBe('new');
  expect(fake.startRun).not.toHaveBeenCalled();
});

it('surfaces a cancelled question as a rejected answer rather than successful delivery', async () => {
  const { fake, session } = setup('cancelled-question');
  await session.load();
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'cancelled',
    function: 'escalate',
    args: { message: 'Question' },
  });
  fake.clientResponse.mockRejectedValueOnce(new ClientRequestNotPendingError());
  await expect(session.send('do not discard this answer')).rejects.toThrow('Your answer was not sent');
  expect(getConversationDraft(session.id).pendingSubmission).toBeUndefined();
  expect(session.panels.state.get().escalation).toBeNull();
  expect(fake.startRun).not.toHaveBeenCalled();
});

it('keeps session-owned tool capabilities after all view subscriptions leave', async () => {
  const { fake, session } = setup('offscreen-tools');
  const handler = vi.fn(async () => ({ ok: true, result: { done: true } }));
  session.setToolHandler(handler);
  const leaveView = session.on('message_output', vi.fn());
  leaveView();
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'background',
    function: 'tool.call',
    args: { tool: 'read' },
  });
  await vi.waitFor(() =>
    expect(fake.clientResponse).toHaveBeenCalledWith('background', true, { done: true }, undefined)
  );
  expect(handler).toHaveBeenCalledTimes(1);
  session.dispose();
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'disposed',
    function: 'tool.call',
    args: { tool: 'read' },
  });
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([false, true])('includes staged context in structured attachment content (queued=%s)', async (queued) => {
  const { fake, session } = setup(`structured-context-${queued}`);
  await session.load();
  session.receive({ type: 'STAGE_CONTEXT', source: 'code', text: 'IMPORTANT_SELECTED_CODE' });
  if (queued) {
    session.panels.set('queuedMessages', [{ id: 'existing', content: 'in queue' }] as any);
  }
  await session.send('Explain this', [new File(['example'], 'sample.txt', { type: 'text/plain' })]);
  const calls: any[][] = queued ? fake.enqueueMessage.mock.calls : fake.startRun.mock.calls;
  const content = queued ? calls[0]?.[2]?.inputContent : calls[0]?.[4];
  expect(content).toEqual([
    { type: 'input_text', text: 'IMPORTANT_SELECTED_CODE' },
    { type: 'input_text', text: 'Explain this' },
    { type: 'input_file', file_data: 'ZXhhbXBsZQ==', filename: 'sample.txt' },
  ]);
  expect(session.actor.getSnapshot().context.stagedContext).toEqual([]);
});

it('replays the original tool result after response delivery fails, without rerunning the tool', async () => {
  const { fake, session } = setup('tool-loss');
  const handler = vi.fn(async () => ({ ok: true, result: { value: 42 } }));
  session.setToolHandler(handler);
  fake.clientResponse.mockRejectedValueOnce(new Error('socket disconnected'));
  const request = { session_id: session.id, request_id: 'tool-1', function: 'tool.call', args: { tool: 'read' } };
  session.dispatch('client_request', request);
  session.dispatch('client_request', request);
  await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(1));
  session.dispatch('client_request', request);
  await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(2));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(fake.clientResponse.mock.calls[0]).toEqual(fake.clientResponse.mock.calls[1]);
  expect(fake.clientResponse).toHaveBeenLastCalledWith('tool-1', true, { value: 42 }, undefined);
});

it('retries notification acknowledgements without duplicating the notification', async () => {
  const { fake, session } = setup('notification-loss');
  fake.clientResponse.mockRejectedValueOnce(new Error('socket disconnected'));
  const request = {
    session_id: session.id,
    request_id: 'notification-1',
    function: 'notify',
    args: { message: 'once' },
  };
  session.dispatch('client_request', request);
  await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(1));
  session.dispatch('client_request', request);
  await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(2));
  expect(session.panels.state.get().notifications).toHaveLength(1);
});

it('retains the submission identity when accepted-send history recovery fails', async () => {
  const { fake, session } = setup('recovery-refresh');
  const readSnapshot = vi.fn(async () => ({
    run_active: false,
    snapshot: { items: [], queue: [], pending_requests: [], stream_id: 'epoch', last_seq: 0 },
  }));
  Object.assign(fake, { getSessionSnapshot: readSnapshot });
  await session.load();
  fake.startRun.mockRejectedValueOnce(new Error('reply lost'));
  await expect(session.send('execute once')).rejects.toThrow('reply lost');
  const id = getConversationDraft(session.id).pendingSubmission!.id;
  const request = fake.request.getMockImplementation()!;
  fake.request.mockImplementation(async (method, params) => {
    if (method === 'queue_status' && params.submission_id) {
      return { submission: { status: 'completed', result: { run_id: 'already-executed' } } };
    }
    return request(method, params);
  });
  readSnapshot.mockRejectedValueOnce(new Error('history temporarily unavailable'));
  await expect(session.send('execute once')).rejects.toThrow('history temporarily unavailable');
  expect(getConversationDraft(session.id).pendingSubmission?.id).toBe(id);
  await session.load({ force: true });
  await expect(session.send('execute once')).resolves.toEqual({ runId: 'already-executed' });
  expect(fake.startRun).toHaveBeenCalledTimes(1);
  expect(getConversationDraft(session.id).pendingSubmission).toBeUndefined();
});

it('retries the identical staged prompt after controller restart and preserves newer context', async () => {
  const { fake, client, session } = setup('context-loss');
  await session.load();
  session.receive({ type: 'STAGE_CONTEXT', source: 'selection', text: 'selected code' });
  fake.startRun.mockRejectedValueOnce(new Error('socket closed before acceptance'));
  await expect(session.send('fix this')).rejects.toThrow('socket closed');
  expect(getConversationDraft(session.id).pendingSubmission?.stagedContext).toEqual([
    { source: 'selection', text: 'selected code' },
  ]);
  session.dispose();
  const second = new ConversationSession(session.id, client);
  sessions.push(second);
  await second.load();
  second.receive({ type: 'STAGE_CONTEXT', source: 'selection', text: 'new selection' });
  await second.send('fix this');
  expect(fake.startRun).toHaveBeenCalledTimes(2);
  expect(fake.startRun.mock.calls[0]).toEqual(fake.startRun.mock.calls[1]);
  expect(second.actor.getSnapshot().context.stagedContext).toEqual([{ source: 'selection', text: 'new selection' }]);
});
