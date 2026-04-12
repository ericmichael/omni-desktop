import { describe, it, expect } from 'vitest';
import { acceptStrictEvent, acceptLooseEvent, type SessionFilterState } from './session-filter';

// ---------------------------------------------------------------------------
// acceptStrictEvent
// ---------------------------------------------------------------------------

describe('acceptStrictEvent', () => {
  it('accepts when session IDs match', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptStrictEvent(state, 'aaa')).toBe(true);
  });

  it('rejects when session IDs differ', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptStrictEvent(state, 'bbb')).toBe(false);
  });

  it('accepts event without session ID when UI has one (legacy)', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptStrictEvent(state, undefined)).toBe(true);
  });

  it('rejects when UI has no session and not starting a run', () => {
    const state: SessionFilterState = { currentSessionId: undefined, startingRun: false };
    expect(acceptStrictEvent(state, 'bbb')).toBe(false);
  });

  it('accepts when UI has no session but startingRun is true', () => {
    const state: SessionFilterState = { currentSessionId: undefined, startingRun: true };
    expect(acceptStrictEvent(state, 'bbb')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // BUG REPRODUCTION: This is the cross-session leak.
  //
  // Scenario: User had session A, starts a new chat (sessionId cleared to
  // undefined), submits a message (startingRun = true).  An event from
  // the OLD session A arrives before run_started sets the new session ID.
  //
  // With the old filter logic, this event is ACCEPTED because
  // sessionId is undefined and startingRun is true — no session check.
  //
  // The fix: when the UI generates a client-side session ID before
  // calling startRun, currentSessionId is always set, so the strict
  // filter rejects the stale event.
  // -----------------------------------------------------------------------
  it('BUG: rejects stale session events during startRun when UI has a session ID', () => {
    // After fix: UI generates session ID before startRun, so currentSessionId
    // is set to the NEW session ID even while startingRun is true.
    const state: SessionFilterState = { currentSessionId: 'new-session', startingRun: true };
    expect(acceptStrictEvent(state, 'old-session')).toBe(false);
  });

  it('BUG: accepts correct session events during startRun when UI has a session ID', () => {
    const state: SessionFilterState = { currentSessionId: 'new-session', startingRun: true };
    expect(acceptStrictEvent(state, 'new-session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acceptLooseEvent
// ---------------------------------------------------------------------------

describe('acceptLooseEvent', () => {
  it('accepts when session IDs match', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptLooseEvent(state, 'aaa')).toBe(true);
  });

  it('rejects when session IDs differ', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptLooseEvent(state, 'bbb')).toBe(false);
  });

  it('accepts when event has no session ID', () => {
    const state: SessionFilterState = { currentSessionId: 'aaa', startingRun: false };
    expect(acceptLooseEvent(state, undefined)).toBe(true);
  });

  it('accepts when UI has no session ID', () => {
    const state: SessionFilterState = { currentSessionId: undefined, startingRun: false };
    expect(acceptLooseEvent(state, 'bbb')).toBe(true);
  });

  it('accepts when neither has session ID', () => {
    const state: SessionFilterState = { currentSessionId: undefined, startingRun: false };
    expect(acceptLooseEvent(state, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration scenario: full session lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle scenarios', () => {
  it('new chat → submit → run_started → events flow correctly', () => {
    // Step 1: User clicks "new chat", UI generates a session ID
    const state: SessionFilterState = { currentSessionId: 'client-uuid', startingRun: false };

    // Step 2: User submits a message
    state.startingRun = true;

    // Step 3: Stale event from old session arrives — must be rejected
    expect(acceptStrictEvent(state, 'old-session')).toBe(false);

    // Step 4: Event from the correct new session arrives — accepted
    expect(acceptStrictEvent(state, 'client-uuid')).toBe(true);

    // Step 5: run_started arrives, startingRun cleared
    state.startingRun = false;

    // Step 6: Normal event flow — matching session accepted
    expect(acceptStrictEvent(state, 'client-uuid')).toBe(true);

    // Step 7: Stale event from old session — still rejected
    expect(acceptStrictEvent(state, 'old-session')).toBe(false);
  });

  it('first ever chat — no persisted session ID', () => {
    // Before fix: sessionId starts undefined, events leak.
    // After fix: handleSubmit generates a UUID before calling startRun.
    const state: SessionFilterState = { currentSessionId: 'generated-uuid', startingRun: true };

    // Events from a different session must be rejected
    expect(acceptStrictEvent(state, 'some-other-session')).toBe(false);

    // Events from the correct session pass
    expect(acceptStrictEvent(state, 'generated-uuid')).toBe(true);
  });

  it('switching sessions clears startingRun and sets new session ID', () => {
    const state: SessionFilterState = { currentSessionId: 'session-a', startingRun: false };

    // User switches to session B
    state.currentSessionId = 'session-b';

    // Events from session A are rejected
    expect(acceptStrictEvent(state, 'session-a')).toBe(false);
    expect(acceptLooseEvent(state, 'session-a')).toBe(false);

    // Events from session B are accepted
    expect(acceptStrictEvent(state, 'session-b')).toBe(true);
    expect(acceptLooseEvent(state, 'session-b')).toBe(true);
  });
});
