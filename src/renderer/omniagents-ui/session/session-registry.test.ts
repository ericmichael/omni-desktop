import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionClosedError } from '@/shared/lifecycle';

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
  it('does not dispatch an upload after its owner is disposed', async () => {
    const { fake, a } = setup();
    await a.load();
    const encoded = deferred<{ content: undefined; attachments: [] }>();
    const read = vi.spyOn(encoding, 'encodeMessage').mockReturnValueOnce(encoded.promise);
    const sending = a.send('delayed upload', []);
    const rejected = expect(sending).rejects.toThrow(/connecting/i);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    a.dispose();
    encoded.resolve({ content: undefined, attachments: [] });
    try {
      await rejected;
      expect(fake.startRun).not.toHaveBeenCalled();
      expect(fake.enqueueMessage).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it('applies remote session settings only to their owner', async () => {
    const { fake, a, b } = setup();
    await Promise.all([a.load(), b.load()]);
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

  it('treats a lost reply as sent when the receipt says the submission completed', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.startRun.mockRejectedValueOnce(new ConnectionClosedError('socket closed'));
    const request = fake.request.getMockImplementation()!;
    fake.request.mockImplementation((method, params) =>
      method === 'queue_status' && params.submission_id
        ? Promise.resolve({ submission: { status: 'completed', result: { run_id: 'accepted' } } })
        : request(method, params)
    );
    await expect(a.send('only once', [], { inputId: 'lost-reply' })).resolves.toEqual({ runId: 'accepted' });
    expect(fake.startRun).toHaveBeenCalledTimes(1);
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
    expect(fake.request.mock.calls.filter(([, params]) => params?.submission_id)).toEqual([
      ['queue_status', { session_id: 'A', submission_id: 'lost-reply' }],
    ]);
    expect(a.actor.getSnapshot().matches({ ready: 'idle' })).toBe(true);
  });

  it('reports a lost reply as a failed send when the server holds no completed receipt', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.startRun.mockRejectedValueOnce(new ConnectionClosedError('socket closed'));
    await expect(a.send('retry', [], { inputId: 'first' })).rejects.toThrow('socket closed');
    expect(fake.request.mock.calls.filter(([, params]) => params?.submission_id)).toHaveLength(1);
    // A resend is a new submission; the server's receipt still covers the old id.
    await a.send('retry', [], { inputId: 'second' });
    expect(fake.startRun).toHaveBeenCalledTimes(2);
    expect((fake.startRun.mock.calls as unknown[][])[1]?.[5]).toBe('second');
    expect(fake.enqueueMessage).not.toHaveBeenCalled();
  });

  it('does not consult the receipt for a failure that is not a transport error', async () => {
    const { fake, a } = setup();
    await a.load();
    fake.startRun.mockRejectedValueOnce(new Error('refused by policy'));
    await expect(a.send('refused')).rejects.toThrow('refused by policy');
    expect(fake.request.mock.calls.filter(([, params]) => params?.submission_id)).toHaveLength(0);
    expect(fake.startRun).toHaveBeenCalledTimes(1);
  });

  it('loads queued work before allowing an idle session to choose its send path', async () => {
    const { fake, a } = setup();
    fake.listQueue.mockResolvedValueOnce({ items: [{ id: 'pending', content: 'already queued' }] });
    await a.load();
    await a.send('next');
    expect(fake.startRun).not.toHaveBeenCalled();
    expect(fake.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it('reports a refused queue admission as a failed send', async () => {
    const { fake, a } = setup();
    fake.listQueue.mockResolvedValueOnce({ items: [{ id: 'pending', content: 'already queued' }] });
    await a.load();
    fake.enqueueMessage.mockResolvedValueOnce({ ok: false, reason: 'queue full' });
    await expect(a.send('next', undefined, { inputId: 'refused-input' })).rejects.toThrow('queue full');
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
    reply.resolve({ message: 'A command result' });
    await command;
    expect(a.actor.getSnapshot().context.items).toEqual([
      expect.objectContaining({ content: expect.stringContaining('A command result') }),
    ]);
    expect(b.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'B response' })]);
  });

  it('keeps a late recap in its owner', async () => {
    const { fake, a, b } = setup();
    await a.load();
    const reply = deferred<any>();
    fake.serverCall.mockImplementationOnce(() => reply.promise);
    const command = a.send('/recap');
    await vi.waitFor(() => expect(fake.serverCall).toHaveBeenCalled());
    reply.resolve({ text: 'command recap' });
    await command;
    expect(a.panels.state.get().recap?.text).toBe('command recap');
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
    await vi.waitFor(() =>
      expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'recovered A' })])
    );
    expect(fake.completeSessionResync).toHaveBeenLastCalledWith('A', 'fake-stream', 0);
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
