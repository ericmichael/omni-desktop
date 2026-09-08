import { afterEach, expect, it, vi } from 'vitest';

import { SESSION_IDLE_CACHE_MS, SessionRegistry } from './session-registry';
import { deferred, fakeSessionClient } from './session-test-support';

afterEach(() => vi.useRealTimers());

it('releases abandoned and failed-to-load controllers once no view owns them', async () => {
  vi.useFakeTimers();
  const { client, fake } = fakeSessionClient();
  const registry = new SessionRegistry(client);
  const abandoned = registry.get('abandoned');
  const failed = registry.get('failed');
  fake.registerSession.mockRejectedValueOnce(new Error('unavailable'));
  await expect(failed.load()).rejects.toThrow('unavailable');
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS + 60_000);
  expect(abandoned.disposed).toBe(true);
  expect(failed.disposed).toBe(true);
  registry.dispose();
});

it('releases 1000 closed idle sessions while another tile retains the connection', async () => {
  vi.useFakeTimers();
  const { client, fake } = fakeSessionClient();
  const registry = new SessionRegistry(client);
  const releaseConnection = registry.retain();
  const visible = registry.get('visible');
  const releaseVisible = registry.retainSession('visible');
  await visible.load();
  for (let i = 0; i < 1000; i++) {
    const id = `closed-${i}`;
    const release = registry.retainSession(id);
    await registry.get(id).load();
    release();
  }
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS + 60_000);
  expect(fake.unregisterSession).toHaveBeenCalledTimes(1000);
  expect(visible.disposed).toBe(false);
  expect(registry.get('visible')).toBe(visible);
  expect(fake.disconnect).not.toHaveBeenCalled();
  releaseVisible();
  releaseConnection();
  registry.dispose();
  expect(fake.retainedListenerCount()).toBe(0);
});

it('keeps offscreen running sessions and pending commands, then evicts after settling', async () => {
  vi.useFakeTimers();
  const { client, fake } = fakeSessionClient();
  const registry = new SessionRegistry(client);
  const running = registry.get('running');
  const command = registry.get('command');
  await running.load();
  await command.load();
  running.receive({ type: 'RUN_STARTED', session_id: 'running', run_id: 'active' });
  const gate = deferred<any>();
  fake.serverCall.mockReturnValueOnce(gate.promise);
  const sending = command.send('/help');
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS * 2);
  expect(running.disposed).toBe(false);
  expect(command.disposed).toBe(false);
  gate.resolve({ message: 'done' });
  await sending;
  running.receive({ type: 'RUN_END', session_id: 'running', run_id: 'active' });
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS + 60_000);
  expect(running.disposed).toBe(true);
  expect(command.disposed).toBe(true);
  const recovered = registry.get('running');
  expect(recovered).not.toBe(running);
  await recovered.load();
  expect(recovered.disposed).toBe(false);
  registry.dispose();
});

it('tolerates StrictMode release/retain and multiple mounted views of one session', async () => {
  vi.useFakeTimers();
  const { client } = fakeSessionClient();
  const registry = new SessionRegistry(client);
  const session = registry.get('shared');
  await session.load();
  const first = registry.retainSession('shared');
  first();
  const second = registry.retainSession('shared');
  const third = registry.retainSession('shared');
  second();
  second();
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS * 2);
  expect(session.disposed).toBe(false);
  third();
  await vi.advanceTimersByTimeAsync(SESSION_IDLE_CACHE_MS + 60_000);
  expect(session.disposed).toBe(true);
  registry.dispose();
});
