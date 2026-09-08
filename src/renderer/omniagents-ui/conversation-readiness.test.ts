import { expect, it } from 'vitest';

import { conversationIsReady } from './conversation-readiness';

it('blocks a stale ready session during navigation, loading, and reconnect', () => {
  const state = { connected: true, bootReady: true, sessionReady: true, sessionId: 'a', expectedSessionId: 'a' };
  expect(conversationIsReady(state)).toBe(true);
  expect(conversationIsReady({ ...state, expectedSessionId: 'b' })).toBe(false);
  expect(conversationIsReady({ ...state, sessionReady: false })).toBe(false);
  expect(conversationIsReady({ ...state, connected: false })).toBe(false);
  expect(conversationIsReady({ ...state, bootReady: false })).toBe(false);
});
