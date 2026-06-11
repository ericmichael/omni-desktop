import { describe, expect, it } from 'vitest';

import { isSafeRelPath, parseChangeSet } from './container-sync';

describe('isSafeRelPath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeRelPath('src/index.ts')).toBe(true);
    expect(isSafeRelPath('a/b/c.txt')).toBe(true);
  });

  it('rejects empty, absolute, and traversal paths', () => {
    expect(isSafeRelPath('')).toBe(false);
    expect(isSafeRelPath('/etc/passwd')).toBe(false);
    expect(isSafeRelPath('../escape')).toBe(false);
    expect(isSafeRelPath('a/../../b')).toBe(false);
  });
});

describe('parseChangeSet', () => {
  const z = (...parts: string[]): string => parts.join('\0');

  it('splits NUL-delimited listings into copy + remove', () => {
    const cs = parseChangeSet(z('gone.txt'), z('src/a.ts', 'src/b.ts'), z('new.txt'));
    expect(cs.copy.sort()).toEqual(['new.txt', 'src/a.ts', 'src/b.ts']);
    expect(cs.remove).toEqual(['gone.txt']);
  });

  it('lets an existing path win over a stale deletion entry (re-created file)', () => {
    // file appears both as deleted and as currently-modified → must be copied, not removed
    const cs = parseChangeSet(z('x.ts'), z('x.ts'), '');
    expect(cs.copy).toEqual(['x.ts']);
    expect(cs.remove).toEqual([]);
  });

  it('dedupes paths that appear in multiple listings', () => {
    const cs = parseChangeSet('', z('dup.ts', 'dup.ts'), z('dup.ts'));
    expect(cs.copy).toEqual(['dup.ts']);
  });

  it('drops unsafe paths (absolute / traversal)', () => {
    const cs = parseChangeSet(z('/abs', '../up'), z('ok.ts', '/etc/x'), z('also-ok.ts', '../../bad'));
    expect(cs.copy.sort()).toEqual(['also-ok.ts', 'ok.ts']);
    expect(cs.remove).toEqual([]);
  });

  it('returns empty sets for empty input', () => {
    expect(parseChangeSet('', '', '')).toEqual({ copy: [], remove: [] });
  });
});
