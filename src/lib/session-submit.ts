/**
 * Ensures a session ID exists before starting a run.
 *
 * When the UI has no session ID (first message, or new chat before
 * handleSelectSession generated one), this function generates a UUID
 * so the event filter is never open to cross-session leaks.
 *
 * Returns the effective session ID and whether a new one was generated.
 */
export function ensureSessionId(
  currentSessionId: string | undefined,
  generateId: () => string,
): { sessionId: string; generated: boolean } {
  if (currentSessionId) {
    return { sessionId: currentSessionId, generated: false };
  }
  return { sessionId: generateId(), generated: true };
}
