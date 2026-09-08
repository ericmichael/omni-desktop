import { afterEach, describe, expect, it, vi } from 'vitest';

import { getConversationDraft, updateConversationDraft } from '@/renderer/omniagents-ui/conversation-drafts';

import * as encoding from './encode-message';
import { SessionRegistry } from './session-registry';
import { deferred, fakeSessionClient, historyPage } from './session-test-support';

const registries: SessionRegistry[] = [];
function setup() {
  const { client, fake } = fakeSessionClient();
  const registry = new SessionRegistry(client);
  registries.push(registry);
  return { registry, fake, a: registry.get('A'), b: registry.get('B') };
}
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

describe('session ownership', () => {
  it('uses a fresh operation after definitive failure without stealing the composer identity', async () => {
    const { fake, a } = setup();
    await a.load();
    const request = fake.request.getMockImplementation()!;
    fake.request.mockImplementation((method, params) =>
      method === 'queue_status' && params.submission_id
        ? Promise.resolve({ submission: { status: 'failed' } })
        : request(method, params)
    );
    updateConversationDraft('A', { pendingInput: { id: 'failed-input', text: 'retry', files: [] } });
    await a.send('retry', [], { inputId: 'failed-input' });
    const id = (fake.startRun.mock.calls as unknown[][])[0]?.[5];
    expect(id).toEqual(expect.any(String));
    expect(id).not.toBe('failed-input');
  });
  it('does not add optimistic UI when another window already completed the input', async () => {
    const { fake, a } = setup();
    await a.load();
    const request = fake.request.getMockImplementation()!;
    fake.request.mockImplementation((method, params) =>
      method === 'queue_status' && params.submission_id === 'completed-input'
        ? Promise.resolve({ submission: { status: 'completed', result: { run_id: 'accepted' } } })
        : request(method, params)
    );
    await expect(a.send('already accepted', [], { inputId: 'completed-input' })).resolves.toEqual({
      runId: 'accepted',
    });
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
    expect(a.actor.getSnapshot().matches({ ready: 'idle' })).toBe(true);
    expect(a.actor.getSnapshot().context.items).toEqual([]);
  });
  it('does not borrow another composer attempt for an independent programmatic send', async () => {
    const { fake, a } = setup();
    await a.load();
    updateConversationDraft('A', { pendingInput: { id: 'composer-owned', text: 'typed message', files: [] } });
    await expect(a.send('independent message')).rejects.toThrow('Another message is pending');
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(getConversationDraft('A').pendingInput?.id).toBe('composer-owned');
    updateConversationDraft('A', { pendingInput: undefined });
  });
  it('keeps one submission identity when another window retries during attachment encoding', async () => {
    const { fake, a } = setup();
    await a.load();
    const other = fakeSessionClient();
    const registry = new SessionRegistry(other.client);
    registries.push(registry);
    const b = registry.get('A');
    await b.load();
    updateConversationDraft('A', { pendingInput: { id: 'shared-input', text: 'same prompt', files: [] } });
    const encoded = deferred<{ content: undefined; attachments: [] }>();
    const read = vi.spyOn(encoding, 'encodeMessage').mockReturnValueOnce(encoded.promise);
    const original = a.send('same prompt', undefined, { inputId: 'shared-input' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await b.send('same prompt', undefined, { inputId: 'shared-input' });
    encoded.resolve({ content: undefined, attachments: [] });
    try {
      await original;
      expect((fake.startRun.mock.calls as unknown[][])[0]?.[5]).toBe(
        (other.fake.startRun.mock.calls as unknown[][])[0]?.[5]
      );
    } finally {
      read.mockRestore();
    }
  });
  it('rejects a queued local send when its environment changes before admission', async () => {
    const { fake, a } = setup();
    await a.load();
    const target = { workspaceId: 'workspace', environmentId: 'host', environmentGeneration: 1 };
    await a.refreshPanels(target);
    const reply = deferred<{ run_id: string }>();
    fake.startRun.mockReturnValueOnce(reply.promise);
    const first = a.send('already dispatched', [], { executionTarget: target });
    await vi.waitFor(() => expect(fake.startRun).toHaveBeenCalledOnce());
    const second = a.send('waiting locally', [], { executionTarget: target });
    const rejected = expect(second).rejects.toThrow('environment changed');
    await a.refreshPanels({ ...target, environmentGeneration: 2 });
    reply.resolve({ run_id: 'first' });
    await first;
    await rejected;
    expect(fake.startRun).toHaveBeenCalledOnce();
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
  });
  it('retries hydration when reconnect occurs before an older hydration settles', async () => {
    const { fake, a } = setup();
    const oldHistory = deferred<any>();
    const request = fake.request.getMockImplementation()!;
    let reads = 0;
    fake.request.mockImplementation((method, params) =>
      method === 'list_items'
        ? ++reads === 1
          ? oldHistory.promise
          : Promise.resolve(historyPage(params.thread_id, 'current transcript'))
        : request(method, params)
    );
    const loading = a.load().catch(() => {});
    await vi.waitFor(() => expect(reads).toBe(1));
    fake.connection(false);
    fake.connection(true);
    oldHistory.reject(new Error('old connection closed'));
    await loading;
    await vi.waitFor(() =>
      expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'current transcript' })])
    );
    expect(a.actor.getSnapshot().matches('ready')).toBe(true);
  });
  it.each(['disposed', 'environment changed'])('does not dispatch an upload after its owner is %s', async (change) => {
    const { fake, a } = setup();
    await a.load();
    const target = { workspaceId: 'workspace', environmentId: 'host', environmentGeneration: 1 };
    await a.refreshPanels(target);
    const encoded = deferred<{ content: undefined; attachments: [] }>();
    const read = vi.spyOn(encoding, 'encodeMessage').mockReturnValueOnce(encoded.promise);
    const sending = a.send('delayed upload', [], { executionTarget: target });
    const rejected = expect(sending).rejects.toThrow(/connecting|environment/i);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    if (change === 'disposed') {
      a.dispose();
    } else {
      await a.refreshPanels({ ...target, environmentGeneration: 2 });
    }
    encoded.resolve({ content: undefined, attachments: [] });
    try {
      await rejected;
      expect(fake.startRun).not.toHaveBeenCalled();
      expect(fake.enqueueMessage).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it('does not let an older send acknowledgment retire a newer submission', async () => {
    const { fake, a } = setup();
    await a.load();
    const reply = deferred<{ run_id: string }>();
    fake.startRun.mockReturnValueOnce(reply.promise);
    const sending = a.send('older message');
    await vi.waitFor(() => expect(fake.startRun).toHaveBeenCalledOnce());
    updateConversationDraft('A', {
      pendingSubmission: { id: 'newer-send', signature: 'newer', queued: false },
      pendingInput: { text: 'newer message', files: [] },
    });
    reply.resolve({ run_id: 'older-run' });
    await sending;
    expect(getConversationDraft('A')).toMatchObject({
      pendingSubmission: { id: 'newer-send' },
      pendingInput: { text: 'newer message' },
    });
    updateConversationDraft('A', { pendingSubmission: undefined, pendingInput: undefined });
  });
  it('applies remote session settings only to their owner and fences older reads', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    const fresh = a.panels.guardRead(['activeModel']);
    fake.emit('client_request', {
      session_id: 'A',
      request_id: 'settings',
      function: 'ui.set_session_state',
      args: { model: 'remote-model', reasoning_effort: 'high', approvals_reviewer: 'auto', workflow_reviewer: 'off' },
    });
    expect(a.panels.state.get()).toMatchObject({
      activeModel: 'remote-model',
      reasoningEffort: 'high',
      approvalsReviewer: 'auto',
      workflowReviewer: 'off',
    });
    expect(b.panels.state.get()).toMatchObject({
      activeModel: null,
      approvalsReviewer: 'user',
      workflowReviewer: 'guardian',
    });
    expect(fresh()).toBe(false);
    await vi.waitFor(() =>
      expect(fake.clientResponse).toHaveBeenCalledWith('settings', true, { ack: true }, undefined)
    );
    fake.emit('client_request', {
      session_id: 'A',
      function: 'ui.set_session_state',
      args: { reasoning_effort: null, approvals_reviewer: 'invalid' },
    });
    expect(a.panels.state.get()).toMatchObject({
      activeModel: 'remote-model',
      reasoningEffort: null,
      approvalsReviewer: 'auto',
      workflowReviewer: 'off',
    });
  });
  it('returns all routers and session registrations to baseline after 1000 three-session owner lifecycles', async () => {
    const { client, fake } = fakeSessionClient();
    const registry = new SessionRegistry(client);
    registries.push(registry);
    for (let cycle = 0; cycle < 1000; cycle++) {
      const release = registry.retain();
      await Promise.all(['A', 'B', 'C'].map((id) => registry.get(`${id}-${cycle}`).load()));
      fake.connection(false);
      fake.connection(true);
      release();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(fake.retainedListenerCount()).toBe(0);
    }
    expect(fake.unregisterSession).toHaveBeenCalledTimes(3000);
  });
  it('does not deliver a late client-tool result after disposal or disturb another tile', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    const result = deferred<{ ok: boolean; result: Record<string, unknown> }>();
    const handler = vi.fn(() => result.promise);
    a.setToolHandler(handler);
    fake.emit('client_request', {
      session_id: 'A',
      request_id: 'late-tool',
      function: 'tool.call',
      args: { tool: 'test', arguments: {} },
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    a.dispose();
    fake.emit('message_output', { session_id: 'B', content: 'B remains live' });
    result.resolve({ ok: true, result: { text: 'A late result' } });
    await result.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.clientResponse).not.toHaveBeenCalled();
    expect(b.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'B remains live' })]);
  });
  it.each(['tool', 'mcp'])('resolves only the owning tile’s %s approval even when request IDs match', async (kind) => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    const params = kind === 'tool' ? { call_id: 'shared' } : { request_id: 'shared' };
    for (const id of ['A', 'B']) {
      fake.emit(`${kind}_approval_requested`, { session_id: id, ...params, tool_name: `tool-${id}`, arguments: '{}' });
    }
    fake.emit(`${kind}_approval_resolved`, { session_id: 'A', ...params });
    expect(a.actor.getSnapshot().context.items.some((item) => item.type === 'approval')).toBe(false);
    expect(b.actor.getSnapshot().context.items.filter((item) => item.type === 'approval')).toHaveLength(1);
    fake.emit(`${kind}_approval_resolved`, { session_id: 'B', ...params });
    expect(b.actor.getSnapshot().context.items.some((item) => item.type === 'approval')).toBe(false);
  });
  it('never turns a question reply with a lost acknowledgement into a fresh run', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.emit('client_request', {
      session_id: 'A',
      request_id: 'original-question',
      function: 'escalate',
      args: { message: 'Question' },
    });
    fake.clientResponse.mockRejectedValueOnce(new Error('connection lost'));
    await expect(a.send('my answer')).rejects.toThrow('connection lost');
    fake.emit('client_request_resolved', { session_id: 'A', request_id: 'original-question' });
    await a.send('my answer');
    expect(fake.clientResponse).toHaveBeenCalledTimes(2);
    expect(fake.clientResponse.mock.calls[1]).toEqual(fake.clientResponse.mock.calls[0]);
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
  });
  it('adopts a snapshot watermark and applies only newer buffered events once', async () => {
    const { fake, a } = setup();
    const snapshot = deferred<any>();
    const read = vi.fn(() => snapshot.promise);
    Object.assign(fake, { getSessionSnapshot: read });
    const load = a.load();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    fake.emit('message_output', { session_id: 'A', stream_id: 'epoch', seq: 4, content: 'already in snapshot' });
    fake.emit('message_output', { session_id: 'A', stream_id: 'epoch', seq: 6, content: 'newer' });
    snapshot.resolve({
      run_active: false,
      snapshot: {
        items: historyPage('A', 'already in snapshot').items,
        queue: [],
        pending_requests: [],
        stream_id: 'epoch',
        last_seq: 5,
      },
    });
    await load;
    fake.emit('message_output', { session_id: 'A', stream_id: 'epoch', seq: 6, content: 'newer' });
    expect(a.actor.getSnapshot().context.items.map((item: any) => item.content)).toEqual([
      'already in snapshot',
      'newer',
    ]);
    expect(fake.completeSessionResync).toHaveBeenCalledWith('A', 'epoch', 5);
  });

  it('reconciles a lost accepted reply without starting or queuing a second run', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.startRun.mockRejectedValueOnce(new Error('connection lost'));
    await expect(a.send('only once')).rejects.toThrow('connection lost');
    fake.request.mockImplementation(async (method, params) =>
      method === 'queue_status'
        ? { run_active: false, submission: { status: 'completed', result: { run_id: 'accepted' } } }
        : historyPage(params.thread_id, 'only once')
    );
    await expect(a.send('only once')).resolves.toEqual({ runId: 'accepted' });
    expect(fake.startRun).toHaveBeenCalledTimes(1);
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
    expect(a.actor.getSnapshot().matches({ ready: 'idle' })).toBe(true);
  });

  it('reuses the original submission id and path when a response is lost', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.startRun.mockRejectedValueOnce(new Error('connection lost'));
    await expect(a.send('retry')).rejects.toThrow();
    await a.send('retry');
    expect(fake.startRun.mock.calls[0]).toEqual(fake.startRun.mock.calls[1]);
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
  });
  it('loads queued work before allowing an idle session to choose its send path', async () => {
    const { fake, a } = setup();
    fake.listQueue.mockResolvedValueOnce({ items: [{ id: 'pending', content: 'already queued' }] });
    await a.load();
    await a.send('next');
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(fake.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the input available for composer restoration when queue admission is refused', async () => {
    const { fake, a } = setup();
    fake.listQueue.mockResolvedValueOnce({ items: [{ id: 'pending', content: 'already queued' }] });
    await a.load();
    updateConversationDraft('A', { pendingInput: { id: 'refused-input', text: 'next', files: [] } });
    fake.enqueueMessage.mockResolvedValueOnce({ ok: false, reason: 'queue full' });
    await expect(a.send('next', undefined, { inputId: 'refused-input' })).rejects.toThrow('queue full');
    expect(getConversationDraft('A').pendingInput).toMatchObject({ id: 'refused-input', text: 'next' });
    expect(getConversationDraft('A').pendingSubmission).toBeUndefined();
    updateConversationDraft('A', { pendingInput: undefined });
  });

  it('re-reads a run snapshot when a newer run event arrives during hydration', async () => {
    const { fake, a } = setup();
    const firstStatus = deferred<any>();
    const request = fake.request.getMockImplementation()!;
    let statusReads = 0;
    fake.request.mockImplementation((method, params) =>
      method === 'queue_status' && ++statusReads === 1 ? firstStatus.promise : request(method, params)
    );
    const load = a.load();
    await vi.waitFor(() => expect(statusReads).toBe(1));
    fake.emit('run_end', { session_id: 'A', run_id: 'finished' });
    firstStatus.resolve({ run_active: true, active_run_id: 'finished' });
    await load;
    expect(statusReads).toBe(2);
    expect(a.actor.getSnapshot().matches({ ready: 'idle' })).toBe(true);
    expect(a.actor.getSnapshot().context.runId).toBeUndefined();
  });

  it('refreshes all registered sessions on reconnect without any mounted views', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    fake.request.mockImplementation(async (method, params) =>
      method === 'list_items' ? historyPage(params.thread_id, `reconnected ${params.thread_id}`) : { run_active: false }
    );
    fake.connection(false);
    fake.connection(true);
    await vi.waitFor(() => {
      expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'reconnected A' })]);
      expect(b.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'reconnected B' })]);
    });
    expect(fake.registerSession).toHaveBeenCalledTimes(4);
  });

  it('does not send while a session model choice is being changed', async () => {
    const { fake, a } = setup();
    await a.load();
    a.panels.set('modelMutating', true);
    await expect(a.send('wait for my model')).rejects.toThrow('Model settings');
    expect(fake.startRun).not.toHaveBeenCalled();
  });
  it('shares one controller per identity and one event router per connection', () => {
    const { registry, fake, a } = setup();
    expect(registry.get('A')).toBe(a);
    expect(fake.on.mock.calls.filter(([name]) => name === 'message_output')).toHaveLength(1);
    expect(setup().a).not.toBe(a);
  });

  it('routes events without a selected view and rejects ambiguous identity', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    fake.emit('message_output', { session_id: 'A', content: 'only A' });
    fake.emit('message_output', { content: 'no owner' });
    fake.emit('message_output', { session_id: 'B', thread_id: 'A', content: 'conflicting owner' });
    expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'only A' })]);
    expect(b.actor.getSnapshot().context.items).toEqual([]);
  });

  it('keeps late command results with A while B receives its own events', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    const reply = deferred<any>();
    fake.serverCall.mockImplementationOnce(() => reply.promise);
    const command = a.send('/help');
    await vi.waitFor(() => expect(fake.serverCall).toHaveBeenCalledWith('help', {}, 'A', undefined));
    fake.emit('message_output', { session_id: 'B', content: 'B response' });
    reply.resolve({ result: 'A command result' });
    await command;
    expect(a.actor.getSnapshot().context.items).toEqual([
      expect.objectContaining({ content: expect.stringContaining('A command result') }),
    ]);
    expect(b.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'B response' })]);
  });

  it('keeps a late recap in its owner, and does not overwrite a newer recap event', async () => {
    const { fake, a, b } = setup();
    await a.load();
    const reply = deferred<any>();
    fake.serverCall.mockImplementationOnce(() => reply.promise);
    const command = a.send('/recap');
    await vi.waitFor(() => expect(fake.serverCall).toHaveBeenCalled());
    fake.emit('client_request', { session_id: 'A', function: 'ui.recap', args: { text: 'newer recap' } });
    reply.resolve({ text: 'old recap' });
    await command;
    expect(a.panels.state.get().recap?.text).toBe('newer recap');
    expect(b.panels.state.get().recap).toBeNull();
  });

  it('keeps an offscreen agent question pending instead of acknowledging it from another view', async () => {
    const { fake, a, b } = setup();
    await a.load();
    fake.emit('client_request', {
      session_id: 'A',
      request_id: 'question',
      function: 'escalate',
      args: { message: 'Approve?' },
    });
    expect(a.panels.state.get().escalation?.request_id).toBe('question');
    expect(b.panels.state.get().escalation).toBeNull();
    expect(fake.clientResponse).not.toHaveBeenCalled();
    await a.send('yes', [new File(['x'], 'x.txt')]);
    expect(fake.clientResponse).toHaveBeenCalledWith('question', true, {
      reply: 'yes',
      input_content: [
        { type: 'input_text', text: 'yes' },
        { type: 'input_file', filename: 'x.txt', file_data: 'eA==' },
      ],
    });
    expect(a.panels.state.get().escalation).toBeNull();
  });

  it('executes a client tool once through its owning session, even with duplicate views/events', async () => {
    const { fake, a, b } = setup();
    const handlerA = vi.fn(async () => ({ ok: true }));
    const handlerB = vi.fn(async () => ({ ok: true }));
    a.setToolHandler(handlerA);
    b.setToolHandler(handlerB);
    const event = {
      session_id: 'A',
      request_id: 'tool-1',
      function: 'tool.call',
      args: { tool: 'hello', arguments: {} },
    };
    fake.emit('client_request', event);
    fake.emit('client_request', event);
    await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(1));
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('coalesces hydration and never publishes idle before active-run status arrives', async () => {
    const { fake, a } = setup();
    const status = deferred<any>();
    const request = fake.request.getMockImplementation()!;
    fake.request.mockImplementation((method, params) =>
      method === 'queue_status' ? status.promise : request(method, params)
    );
    const observed: unknown[] = [];
    a.actor.subscribe((s) => observed.push(s.value));
    const first = a.load();
    const second = a.load();
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledWith('queue_status', { session_id: 'A' }));
    await expect(a.send('too early')).rejects.toThrow('still connecting');
    expect(a.actor.getSnapshot().matches('initializing')).toBe(true);
    status.resolve({ run_active: true, active_run_id: 'running-A' });
    await Promise.all([first, second]);
    expect(fake.registerSession).toHaveBeenCalledTimes(1);
    expect(a.actor.getSnapshot().matches({ ready: 'running' })).toBe(true);
    expect(observed).not.toContainEqual({ ready: 'idle' });
  });

  it('does not replace a live queue update with a delayed snapshot', async () => {
    const { fake, a } = setup();
    const read = deferred<any>();
    fake.listQueue.mockImplementationOnce(() => read.promise);
    const refresh = a.refreshPanels();
    fake.emit('queue_changed', { session_id: 'A', items: [{ id: 'new' }] });
    read.resolve({ items: [{ id: 'old' }] });
    await refresh;
    expect(a.panels.state.get().queuedMessages).toEqual([{ id: 'new' }]);
  });

  it('serializes sends from two views of a session; the second queues', async () => {
    const { fake, a } = setup();
    await a.load();
    const start = deferred<{ run_id: string }>();
    fake.startRun.mockImplementationOnce(() => start.promise);
    const first = a.send('first');
    const second = a.send('second');
    await vi.waitFor(() => expect(fake.startRun).toHaveBeenCalledTimes(1));
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
    start.resolve({ run_id: 'run-A' });
    await Promise.all([first, second]);
    expect(fake.startRun).toHaveBeenCalledTimes(1);
    expect(fake.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it('queue refusal does not reset an active run to idle', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.emit('run_started', { session_id: 'A', run_id: 'active' });
    fake.enqueueMessage.mockResolvedValueOnce({ ok: false, reason: 'full' });
    await expect(a.send('follow up')).rejects.toThrow('full');
    expect(a.actor.getSnapshot().matches({ ready: 'running' })).toBe(true);
  });

  it('resyncs offscreen A without resetting B', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
    fake.emit('message_output', { session_id: 'B', content: 'keep B' });
    fake.request.mockImplementation(async (method, params) =>
      method === 'list_items' ? historyPage(params.thread_id, 'recovered A') : { run_active: false }
    );
    fake.resync('A');
    await vi.waitFor(() => expect(fake.completeSessionResync).toHaveBeenCalledWith('A'));
    expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'recovered A' })]);
    expect(b.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'keep B' })]);
  });

  it('provider teardown releases sessions, but never lets a view disconnect the socket', async () => {
    const { registry, fake, a } = setup();
    await a.load();
    const release = registry.retain();
    release();
    const strictModeRetain = registry.retain();
    await Promise.resolve();
    expect(a.disposed).toBe(false);
    strictModeRetain();
    await Promise.resolve();
    expect(a.disposed).toBe(true);
    expect(fake.unregisterSession).toHaveBeenCalledWith('A');
    expect(fake.disconnect).not.toHaveBeenCalled();
  });
});
