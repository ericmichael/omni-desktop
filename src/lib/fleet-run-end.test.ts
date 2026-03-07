import { describe, expect, it } from 'vitest';

import { classifyRunEndReason, decideRunEndAction } from './fleet-run-end';

// ---------------------------------------------------------------------------
// classifyRunEndReason
// ---------------------------------------------------------------------------

describe('classifyRunEndReason', () => {
  it.each([
    ['completed', 'completed'],
    ['done', 'completed'],
    ['finished', 'completed'],
    ['success', 'completed'],
    ['Completed', 'completed'], // case-insensitive
    ['DONE', 'completed'],
  ] as const)('"%s" → %s', (input, expected) => {
    expect(classifyRunEndReason(input)).toBe(expected);
  });

  it.each([
    ['stopped', 'stopped'],
    ['cancelled', 'stopped'],
    ['canceled', 'stopped'],
    ['user_stopped', 'stopped'],
    ['STOPPED', 'stopped'],
  ] as const)('"%s" → %s', (input, expected) => {
    expect(classifyRunEndReason(input)).toBe(expected);
  });

  it.each([
    ['max_turns', 'max_turns'],
    ['MAX_TURNS', 'max_turns'],
  ] as const)('"%s" → %s', (input, expected) => {
    expect(classifyRunEndReason(input)).toBe(expected);
  });

  it.each([
    ['stalled', 'stalled'],
    ['STALLED', 'stalled'],
  ] as const)('"%s" → %s', (input, expected) => {
    expect(classifyRunEndReason(input)).toBe(expected);
  });

  it.each([
    'error',
    'crash',
    'timeout',
    'guardrail_violation',
    'unknown_reason',
    '',
  ])('"%s" → error (default)', (input) => {
    expect(classifyRunEndReason(input)).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// decideRunEndAction
// ---------------------------------------------------------------------------

describe('decideRunEndAction', () => {
  const defaults = {
    continuationTurn: 0,
    maxContinuationTurns: 10,
  };

  // --- stopped ---

  it('returns stopped for cancelled', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'cancelled',
    });
    expect(action).toEqual({ type: 'stopped' });
  });

  // --- completed ---

  it('returns continue when completed and under max turns', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'completed',
      continuationTurn: 2,
      maxContinuationTurns: 10,
    });
    expect(action).toEqual({ type: 'continue', nextTurn: 3 });
  });

  it('returns complete when completed and max turns reached', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'completed',
      continuationTurn: 9,
      maxContinuationTurns: 10,
    });
    expect(action).toEqual({ type: 'complete' });
  });

  it('returns continue when completed at turn 0', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'completed',
      continuationTurn: 0,
    });
    expect(action).toEqual({ type: 'continue', nextTurn: 1 });
  });

  // --- max_turns ---

  it('returns continue for max_turns (continues with fresh run)', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'max_turns',
      continuationTurn: 2,
      maxContinuationTurns: 10,
    });
    expect(action).toEqual({ type: 'continue', nextTurn: 3 });
  });

  it('returns complete for max_turns at continuation limit', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'max_turns',
      continuationTurn: 9,
      maxContinuationTurns: 10,
    });
    expect(action).toEqual({ type: 'complete' });
  });

  // --- errors ---

  it('returns retry for error reasons', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'error',
    });
    expect(action).toEqual({ type: 'retry', failureClass: 'error' });
  });

  it('returns retry for guardrail_violation', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'guardrail_violation',
    });
    expect(action).toEqual({ type: 'retry', failureClass: 'error' });
  });

  it('returns retry for stalled', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'stalled',
    });
    expect(action).toEqual({ type: 'retry', failureClass: 'stalled' });
  });

  // --- edge cases ---

  it('continuation turn 0 with max 1 returns complete', () => {
    const action = decideRunEndAction({
      reason: 'completed',
      continuationTurn: 0,
      maxContinuationTurns: 1,
    });
    expect(action).toEqual({ type: 'complete' });
  });

  it('stopped takes priority over everything', () => {
    const action = decideRunEndAction({
      ...defaults,
      reason: 'stopped',
    });
    expect(action).toEqual({ type: 'stopped' });
  });
});
