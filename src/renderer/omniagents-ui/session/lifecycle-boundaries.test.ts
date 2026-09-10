import { afterEach, expect, it, vi } from 'vitest';

import { resetConversation } from './reset-conversation';
import { deferred } from './session-test-support';

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
