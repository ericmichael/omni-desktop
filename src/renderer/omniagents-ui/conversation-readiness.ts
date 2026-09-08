/** Transport, boot, and the selected conversation must agree before a send. */
export function conversationIsReady(state: {
  connected: boolean;
  bootReady: boolean;
  sessionReady: boolean;
  sessionId?: string;
  expectedSessionId?: string;
}) {
  return Boolean(
    state.connected &&
    state.bootReady &&
    state.sessionReady &&
    state.sessionId &&
    (!state.expectedSessionId || state.expectedSessionId === state.sessionId)
  );
}
