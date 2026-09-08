import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionReplayCoordinator } from '@/renderer/omniagents-ui/rpc/replay';

import { ConversationSession } from './conversation-session';
import { fakeSessionClient, historyPage } from './session-test-support';

const sessions: ConversationSession[] = [];
afterEach(() => sessions.splice(0).forEach((session) => session.dispose()));

function harness(id = 'protocol-owner') {
  const { client, fake } = fakeSessionClient();
  const session = new ConversationSession(id, client);
  sessions.push(session);
  const events: Array<{ method: string; params: any }> = [];
  const replay = new SessionReplayCoordinator(
    async (sessionId, _stream, after) => ({
      session_id: sessionId,
      stream_id: 'epoch',
      last_seq: events.length,
      events: events.filter((event) => event.params.seq > after),
    }),
    (method, params) => session.dispatch(method, params)
  );
  const emit = (method: string, params: any = {}, deliver = true) => {
    const event = { method, params: { ...params, session_id: id, stream_id: 'epoch', seq: events.length + 1 } };
    events.push(event);
    if (deliver && !replay.handle(event.method, event.params)) {
      session.dispatch(event.method, event.params);
    }
    return event;
  };
  return { fake, session, replay, emit, events };
}

function snapshot(items: any[] = [], pending: any[] = [], run?: string) {
  return {
    run_active: Boolean(run),
    active_run_id: run,
    snapshot: {
      items,
      pending_requests: pending,
      queue: [],
      stream_id: 'epoch',
      last_seq: 50,
    },
  };
}

describe('protocol path convergence', () => {
  it('restores acknowledged display state without replaying its response', async () => {
    const { session, fake, emit } = harness();
    await session.load();
    emit('run_started', { run_id: 'run' });
    const request = {
      session_id: session.id,
      request_id: 'display',
      function: 'ui.set_status',
      args: { text: 'Analysing' },
    };
    emit('client_request', request);
    await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledTimes(1));
    const response = snapshot([], [], 'run');
    Object.assign(response.snapshot, { state_events: [{ method: 'client_request', params: request }] });
    Object.assign(fake, { getSessionSnapshot: vi.fn(async () => response) });
    await session.load({ force: true });
    expect(session.actor.getSnapshot().context.status).toBe('Analysing');
    expect(fake.clientResponse).toHaveBeenCalledTimes(1);
  });
  it('MCP surfaces retain invocation identity across runs and survive canonical reload', async () => {
    const live = harness('mcp-owner');
    const fresh = harness('mcp-owner');
    await live.session.load();
    const items: any[] = [];
    for (const [index, run] of ['first', 'second'].entries()) {
      const metadata = { mcp_ui: { server_name: 'server', tool_name: 'widget', resource: `<p>${run}</p>` } };
      live.emit('run_started', { run_id: run });
      live.emit('tool_called', { run_id: run, call_id: 'reused', tool: 'widget', input: '{}' });
      live.emit('tool_result', { run_id: run, call_id: 'reused', tool: 'widget', output: run, metadata });
      live.emit('run_end', { run_id: run });
      items.push({
        ...historyPage('mcp-owner', run).items[0],
        item_id: `tool-${run}`,
        kind: 'tool_call',
        seq: index + 1,
        turn_id: run,
        content: { call_id: 'reused', tool: 'widget', output: run, metadata },
      });
    }
    Object.assign(fresh.fake, { getSessionSnapshot: vi.fn(async () => snapshot(items)) });
    await fresh.session.load();
    const artifacts = (s: ConversationSession) =>
      s.actor
        .getSnapshot()
        .context.items.filter((item) => item.type === 'artifact')
        .map(({ updated_at: _updated, ...item }: any) => item);
    expect(artifacts(live.session)).toHaveLength(2);
    expect(artifacts(fresh.session)).toEqual(artifacts(live.session));
  });
  it.each([0, 1, 2, 3, 4])('live and replay converge when disconnected after event %s', async (cut) => {
    const live = harness('live');
    const resumed = harness('resumed');
    await Promise.all([live.session.load(), resumed.session.load()]);
    resumed.replay.registerSession(resumed.session.id);
    const script = [
      ['run_started', { run_id: 'run', prompt: 'question' }],
      ['tool_called', { run_id: 'run', tool: 'echo', call_id: 'call', input: '{}' }],
      ['tool_result', { run_id: 'run', tool: 'echo', call_id: 'call', output: 'result' }],
      ['message_output', { run_id: 'run', message_id: 'answer', content: 'answer' }],
      ['run_end', { run_id: 'run' }],
    ] as const;
    script.forEach(([method, params], index) => {
      live.emit(method, params);
      resumed.emit(method, params, index < cut);
    });
    await resumed.replay.resumeAll();
    await resumed.replay.resumeAll(); // duplicate delivery is not another action
    expect(resumed.session.actor.getSnapshot().context.items).toEqual(live.session.actor.getSnapshot().context.items);
    expect(resumed.session.actor.getSnapshot().matches({ ready: 'idle' })).toBe(true);
  });

  it('an authoritative snapshot removes an approval resolved by another consumer', async () => {
    const { session, emit, fake } = harness();
    await session.load();
    emit('run_started', { run_id: 'run' });
    emit('tool_approval_requested', { run_id: 'run', call_id: 'decision', tool_name: 'echo', arguments: '{}' });
    expect(session.actor.getSnapshot().context.pendingApprovals.size).toBe(1);
    Object.assign(fake, { getSessionSnapshot: vi.fn(async () => snapshot()) });
    await session.load({ force: true });
    expect(session.actor.getSnapshot().context.pendingApprovals.size).toBe(0);
    expect(session.actor.getSnapshot().context.items).toEqual([]);
  });

  it('a pending status request restores and acknowledges just as live delivery does', async () => {
    const { session, fake } = harness();
    const request = {
      session_id: session.id,
      request_id: 'status',
      function: 'ui.set_status',
      args: { text: 'Waiting for analysis', show_spinner: false },
    };
    Object.assign(fake, { getSessionSnapshot: vi.fn(async () => snapshot([], [request], 'run')) });
    await session.load();
    expect(session.actor.getSnapshot().context.status).toBe('Waiting for analysis');
    await vi.waitFor(() => expect(fake.clientResponse).toHaveBeenCalledWith('status', true, { ack: true }, undefined));
  });

  it('late output keeps its originating run instead of being assigned to the current run', async () => {
    const { session, emit } = harness();
    await session.load();
    emit('run_started', { run_id: 'old' });
    emit('run_end', { run_id: 'old' });
    emit('run_started', { run_id: 'new' });
    emit('message_output', { run_id: 'old', message_id: 'delayed', content: 'old answer' });
    expect(session.actor.getSnapshot().context.items.at(-1)).toMatchObject({ runId: 'old' });
    expect(session.actor.getSnapshot().context.runId).toBe('new');
  });

  it('fresh canonical loading produces the same identified assistant message as live delivery', async () => {
    const live = harness('same');
    const fresh = harness('same');
    await live.session.load();
    live.emit('run_started', { run_id: 'run' });
    live.emit('message_output', { run_id: 'run', message_id: 'message', content: 'answer' });
    live.emit('run_end', { run_id: 'run' });
    const canonical = {
      ...historyPage('same', 'answer').items[0],
      kind: 'agent_message',
      role: 'assistant',
      turn_id: 'run',
      content: { text: 'answer', message_id: 'message' },
    };
    Object.assign(fresh.fake, { getSessionSnapshot: vi.fn(async () => snapshot([canonical])) });
    await fresh.session.load();
    const normalize = (s: ConversationSession) =>
      s.actor.getSnapshot().context.items.map((item: any) => ({
        type: item.type,
        role: item.role,
        content: item.content,
        message_id: item.message_id,
      }));
    expect(normalize(fresh.session)).toEqual(normalize(live.session));
  });
});
