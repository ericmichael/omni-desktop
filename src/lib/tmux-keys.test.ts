import { describe, expect, it } from 'vitest';

import { keysToBytes, tokenToBytes } from '@/lib/tmux-keys';

describe('tokenToBytes', () => {
  it('maps control chords (case-insensitive)', () => {
    expect(tokenToBytes('C-c')).toBe('\x03');
    expect(tokenToBytes('C-C')).toBe('\x03');
    expect(tokenToBytes('C-d')).toBe('\x04');
    expect(tokenToBytes('C-[')).toBe('\x1b'); // C-[ == Escape
    expect(tokenToBytes('C-@')).toBe('\x00');
  });

  it('maps meta/alt chords (case-sensitive char)', () => {
    expect(tokenToBytes('M-b')).toBe('\x1bb');
    expect(tokenToBytes('M-B')).toBe('\x1bB');
  });

  it('maps named keys', () => {
    expect(tokenToBytes('Enter')).toBe('\r');
    expect(tokenToBytes('Tab')).toBe('\t');
    expect(tokenToBytes('Escape')).toBe('\x1b');
    expect(tokenToBytes('Up')).toBe('\x1b[A');
    expect(tokenToBytes('BSpace')).toBe('\x7f');
    expect(tokenToBytes('F5')).toBe('\x1b[15~');
  });

  it('sends unrecognized tokens literally', () => {
    expect(tokenToBytes('git status')).toBe('git status');
    expect(tokenToBytes('Ctrl-c')).toBe('Ctrl-c'); // not tmux syntax → literal
    expect(tokenToBytes('q')).toBe('q');
  });
});

describe('keysToBytes', () => {
  it('concatenates a resolved sequence', () => {
    expect(keysToBytes(['git status', 'Enter'])).toBe('git status\r');
    expect(keysToBytes(['Escape', ':q!', 'Enter'])).toBe('\x1b:q!\r');
    expect(keysToBytes(['Up', 'Up', 'Enter'])).toBe('\x1b[A\x1b[A\r');
  });

  it('literal mode sends every token verbatim (tmux -l)', () => {
    expect(keysToBytes(['Enter'], { literal: true })).toBe('Enter');
    expect(keysToBytes(['C-c', 'Up'], { literal: true })).toBe('C-cUp');
  });

  it('count repeats the whole sequence (tmux -N) and clamps', () => {
    expect(keysToBytes(['C-c'], { count: 2 })).toBe('\x03\x03');
    expect(keysToBytes(['a', 'b'], { count: 3 })).toBe('ababab');
    expect(keysToBytes(['x'], { count: 0 })).toBe('x'); // clamped to >= 1
    expect(keysToBytes(['x'], { count: 99999 }).length).toBe(1000); // clamped to MAX
  });
});
