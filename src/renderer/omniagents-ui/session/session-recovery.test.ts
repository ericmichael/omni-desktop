import { afterEach, expect, it, vi } from 'vitest';

import { ClientRequestNotPendingError } from '@/renderer/omniagents-ui/rpc/client-response-error';
import { ConnectionClosedError } from '@/shared/lifecycle';

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

it('resends a lost answer to the same question and clears the banner once it is acknowledged', async () => {
  const { fake, session } = setup('question-receipt');
  await session.load();
  session.dispatch('client_request', {
    session_id: session.id,
    request_id: 'old',
    function: 'escalate',
    args: { message: 'Old question' },
  });
  fake.clientResponse.mockRejectedValueOnce(new ConnectionClosedError('ack lost'));
  await expect(session.send('original answer')).rejects.toThrow('ack lost');
  // The question is still pending as far as the client knows; the composer
  // keeps the text and a resend targets the same request id, which the
  // server's per-request receipt acknowledges without consuming it twice.
  expect(session.panels.state.get().escalation?.request_id).toBe('old');
  await session.send('original answer');
  expect(fake.clientResponse).toHaveBeenCalledTimes(2);
  expect(fake.clientResponse.mock.calls[0]).toEqual(fake.clientResponse.mock.calls[1]);
  expect(session.panels.state.get().escalation).toBeNull();
  expect(fake.startRun).not.toHaveBeenCalled();
  expect(fake.request.mock.calls.filter(([, params]) => params?.submission_id)).toHaveLength(0);
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
