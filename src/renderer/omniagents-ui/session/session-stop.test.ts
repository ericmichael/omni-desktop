import { expect, it } from 'vitest';

import { ConversationSession } from './conversation-session';
import { deferred, fakeSessionClient } from './session-test-support';

async function running(id: string) {
  const { fake, client } = fakeSessionClient();
  const session = new ConversationSession(id, client);
  await session.load();
  session.receive({ type: 'RUN_STARTED', session_id: id, run_id: `${id}-run` });
  return { session, fake };
}

it('coalesces stop requests and restores a retryable state with visible failure', async () => {
  const { session, fake } = await running('A');
  const gate = deferred<any>();
  fake.stopRun.mockReturnValueOnce(gate.promise);
  const stopping = session.stopRun();
  expect(session.stopRun()).toBe(stopping);
  expect(session.actor.getSnapshot().matches({ ready: 'stopping' })).toBe(true);
  gate.reject(new Error('offline'));
  await expect(stopping).rejects.toThrow('offline');
  expect(fake.stopRun).toHaveBeenCalledExactlyOnceWith('A-run');
  expect(session.actor.getSnapshot().matches({ ready: 'running' })).toBe(true);
  expect(JSON.stringify(session.actor.getSnapshot().context.items)).toContain('Could not stop the run: offline');
  await session.stopRun();
  expect(fake.stopRun).toHaveBeenCalledTimes(2);
  session.dispose();
});

it('enters stopping from an approval and preserves the pending approval on failure', async () => {
  const { session, fake } = await running('approval');
  session.receive({ type: 'REQUEST_APPROVAL', session_id: session.id, request_id: 'token', tool: 'bash' });
  expect(session.actor.getSnapshot().matches({ ready: 'awaitingApproval' })).toBe(true);
  fake.stopRun.mockRejectedValueOnce(new Error('offline'));
  const stopping = session.stopRun();
  expect(session.actor.getSnapshot().matches({ ready: 'stopping' })).toBe(true);
  await expect(stopping).rejects.toThrow('offline');
  expect(session.actor.getSnapshot().matches({ ready: 'awaitingApproval' })).toBe(true);
  expect(session.actor.getSnapshot().context.pendingApprovals.has('token')).toBe(true);
  session.dispose();
});

it.each(['success', 'failure'])('does not apply a late stop %s to a newer run or another tile', async (outcome) => {
  const a = await running('A');
  const b = await running('B');
  const gate = deferred<any>();
  a.fake.stopRun.mockReturnValueOnce(gate.promise);
  const stopping = a.session.stopRun();
  a.session.receive({ type: 'RUN_END', session_id: 'A', run_id: 'A-run' });
  a.session.receive({ type: 'RUN_STARTED', session_id: 'A', run_id: 'next-run' });
  if (outcome === 'failure') {
    gate.reject(new Error('late failure'));
    await expect(stopping).rejects.toThrow();
  } else {
    gate.resolve({});
    await stopping;
  }
  expect(a.session.actor.getSnapshot().context.runId).toBe('next-run');
  expect(a.session.actor.getSnapshot().matches({ ready: 'running' })).toBe(true);
  expect(JSON.stringify(a.session.actor.getSnapshot().context.items)).not.toContain('late failure');
  expect(b.fake.stopRun).not.toHaveBeenCalled();
  expect(b.session.actor.getSnapshot().context.runId).toBe('B-run');
  a.session.dispose();
  b.session.dispose();
});

it('does not cancel an idle or disposed session', async () => {
  const { fake, client } = fakeSessionClient();
  const session = new ConversationSession('idle', client);
  await session.load();
  await session.stopRun();
  session.dispose();
  await expect(session.stopRun()).rejects.toThrow('closed');
  expect(fake.stopRun).not.toHaveBeenCalled();
});

it('retires only the ending run approvals and ignores a stale run end', async () => {
  const { session } = await running('A');
  session.receive({ type: 'REQUEST_APPROVAL', session_id: 'A', request_id: 'own', tool: 'bash', run_id: 'A-run' });
  session.receive({
    type: 'REQUEST_APPROVAL',
    session_id: 'A',
    request_id: 'other',
    tool: 'bash',
    run_id: 'other-run',
  });
  session.dispatch('run_end', { session_id: 'A', run_id: 'old-run' });
  expect(session.actor.getSnapshot().context.runId).toBe('A-run');
  session.dispatch('run_end', { session_id: 'A', run_id: 'A-run' });
  expect(session.actor.getSnapshot().context.pendingApprovals.has('own')).toBe(false);
  expect(session.actor.getSnapshot().context.pendingApprovals.has('other')).toBe(true);
  expect(
    session.actor
      .getSnapshot()
      .context.items.filter((item) => item.type === 'approval')
      .map((item) => item.request_id)
  ).toEqual(['other']);
  session.dispose();
});

it('binds recovered approval cards to the snapshot active run for cancellation cleanup', async () => {
  const { fake, client } = fakeSessionClient();
  const session = new ConversationSession('recovered', client);
  await session.load();
  session.receive({ type: 'HYDRATE' });
  session.receive({
    type: 'HISTORY_LOADED',
    active_run_id: 'recovered-run',
    items: [{ type: 'approval', request_id: 'recovered-token', tool: 'bash', session_id: 'recovered' }],
  });
  await session.stopRun();
  expect(fake.stopRun).toHaveBeenCalledWith('recovered-run');
  session.dispatch('run_end', { session_id: 'recovered', run_id: 'recovered-run' });
  expect(session.actor.getSnapshot().context.pendingApprovals.size).toBe(0);
  expect(session.actor.getSnapshot().context.items.some((item) => item.type === 'approval')).toBe(false);
  session.dispose();
});
