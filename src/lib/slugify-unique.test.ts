import { describe, expect, it } from 'vitest';

import { slugifyUnique } from './slugify-unique';

describe('slugifyUnique', () => {
  it('returns the candidate unchanged when not taken', () => {
    expect(slugifyUnique('my-project', () => false)).toBe('my-project');
  });

  it('appends -2 on first collision', () => {
    const taken = new Set(['my-project']);
    expect(slugifyUnique('my-project', (s) => taken.has(s))).toBe('my-project-2');
  });

  it('skips taken disambiguators', () => {
    const taken = new Set(['my-project', 'my-project-2', 'my-project-3']);
    expect(slugifyUnique('my-project', (s) => taken.has(s))).toBe('my-project-4');
  });

  it('throws after 999 attempts', () => {
    expect(() => slugifyUnique('p', () => true)).toThrow(/exhausted 999/);
  });
});
