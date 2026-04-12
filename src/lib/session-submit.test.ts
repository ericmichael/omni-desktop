import { describe, it, expect, vi } from 'vitest';
import { ensureSessionId } from './session-submit';
import { acceptStrictEvent, type SessionFilterState } from './session-filter';

describe('ensureSessionId', () => {
  it('returns existing session ID without generating', () => {
    const gen = vi.fn(() => 'new-uuid');
    const result = ensureSessionId('existing-id', gen);
    expect(result).toEqual({ sessionId: 'existing-id', generated: false });
    expect(gen).not.toHaveBeenCalled();
  });

  it('generates a new ID when current is undefined', () => {
    const gen = vi.fn(() => 'generated-uuid');
    const result = ensureSessionId(undefined, gen);
    expect(result).toEqual({ sessionId: 'generated-uuid', generated: true });
    expect(gen).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// End-to-end scenario proving the fix closes the cross-session leak
// ---------------------------------------------------------------------------

describe('handleSubmit session safety', () => {
  /**
   * Simulates the old (buggy) App.tsx handleSubmit flow:
   *
   *   1. sessionId = undefined (no persisted session)
   *   2. startingRunRef = true
   *   3. client.startRun(text, sessionId)  ← sends undefined
   *   4. Events arrive from any session → ACCEPTED (bug!)
   */
  it('BUG: old flow leaks events when sessionId is undefined', () => {
    // Simulating old behavior: sessionId stays undefined
    const state: SessionFilterState = {
      currentSessionId: undefined, // <-- the bug: never set before startRun
      startingRun: true,
    };

    // Stale event from a completely different session — incorrectly accepted
    expect(acceptStrictEvent(state, 'stale-session-abc')).toBe(true); // BUG!
  });

  /**
   * Simulates the fixed handleSubmit flow:
   *
   *   1. sessionId = undefined (no persisted session)
   *   2. ensureSessionId() → generates 'fresh-uuid', sets sessionId
   *   3. startingRunRef = true
   *   4. client.startRun(text, 'fresh-uuid')
   *   5. Events from other sessions → REJECTED (correct!)
   */
  it('FIX: new flow rejects stale events because sessionId is always set', () => {
    const { sessionId } = ensureSessionId(undefined, () => 'fresh-uuid');

    const state: SessionFilterState = {
      currentSessionId: sessionId, // <-- always set now
      startingRun: true,
    };

    // Stale event from different session — correctly rejected
    expect(acceptStrictEvent(state, 'stale-session-abc')).toBe(false);

    // Event from the correct new session — accepted
    expect(acceptStrictEvent(state, 'fresh-uuid')).toBe(true);
  });

  /**
   * Verifies that re-submitting within an existing session doesn't
   * generate a new ID (preserves conversation continuity).
   */
  it('does not regenerate session ID for subsequent messages', () => {
    const gen = vi.fn(() => 'should-not-be-called');
    const result = ensureSessionId('existing-session', gen);
    expect(result.sessionId).toBe('existing-session');
    expect(result.generated).toBe(false);
    expect(gen).not.toHaveBeenCalled();
  });
});
