import { describe, expect, it } from 'vitest';

import { isActivePhase, isStreamingPhase, isValidTransition } from '@/shared/ticket-phase';
import type { TicketPhase } from '@/shared/ticket-phase';

const ALL_PHASES: TicketPhase[] = [
  'idle',
  'provisioning',
  'connecting',
  'session_creating',
  'ready',
  'running',
  'continuing',
  'awaiting_input',
  'retrying',
  'error',
  'completed',
];

describe('isValidTransition', () => {
  it('allows idle → provisioning', () => {
    expect(isValidTransition('idle', 'provisioning')).toBe(true);
  });

  it('rejects idle → running (must provision first)', () => {
    expect(isValidTransition('idle', 'running')).toBe(false);
  });

  it('allows running → continuing', () => {
    expect(isValidTransition('running', 'continuing')).toBe(true);
  });

  it('allows running → completed', () => {
    expect(isValidTransition('running', 'completed')).toBe(true);
  });

  it('allows running → error', () => {
    expect(isValidTransition('running', 'error')).toBe(true);
  });

  it('allows continuing → running', () => {
    expect(isValidTransition('continuing', 'running')).toBe(true);
  });

  it('allows error → provisioning (retry)', () => {
    expect(isValidTransition('error', 'provisioning')).toBe(true);
  });

  it('allows error → idle (reset)', () => {
    expect(isValidTransition('error', 'idle')).toBe(true);
  });

  it('rejects error → running (must provision first)', () => {
    expect(isValidTransition('error', 'running')).toBe(false);
  });

  it('allows completed → idle', () => {
    expect(isValidTransition('completed', 'idle')).toBe(true);
  });

  it('rejects completed → running', () => {
    expect(isValidTransition('completed', 'running')).toBe(false);
  });

  it('every phase can reach idle (directly or transitively)', () => {
    for (const phase of ALL_PHASES) {
      if (phase === 'idle') continue;
      expect(isValidTransition(phase, 'idle')).toBe(true);
    }
  });

  it('rejects same-phase transitions', () => {
    for (const phase of ALL_PHASES) {
      // Same-phase should not be in the transition table
      // (the machine short-circuits these, but the table shouldn't list them)
      expect(isValidTransition(phase, phase)).toBe(false);
    }
  });
});

describe('isActivePhase', () => {
  it('returns false for idle, error, completed', () => {
    expect(isActivePhase('idle')).toBe(false);
    expect(isActivePhase('error')).toBe(false);
    expect(isActivePhase('completed')).toBe(false);
  });

  it('returns true for all other phases', () => {
    const active: TicketPhase[] = [
      'provisioning',
      'connecting',
      'session_creating',
      'ready',
      'running',
      'continuing',
      'awaiting_input',
      'retrying',
    ];
    for (const phase of active) {
      expect(isActivePhase(phase)).toBe(true);
    }
  });
});

describe('isStreamingPhase', () => {
  it('returns true only for running and continuing', () => {
    expect(isStreamingPhase('running')).toBe(true);
    expect(isStreamingPhase('continuing')).toBe(true);
  });

  it('returns false for other phases', () => {
    const nonStreaming: TicketPhase[] = [
      'idle',
      'provisioning',
      'connecting',
      'session_creating',
      'ready',
      'awaiting_input',
      'retrying',
      'error',
      'completed',
    ];
    for (const phase of nonStreaming) {
      expect(isStreamingPhase(phase)).toBe(false);
    }
  });
});
