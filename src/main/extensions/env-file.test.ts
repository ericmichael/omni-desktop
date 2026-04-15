/**
 * Tests for env-file.ts — .env file parser.
 *
 * Covers standard KEY=VALUE parsing, comments, blank lines, edge cases
 * (no equals sign, empty key, empty value, whitespace handling).
 */
import { describe, expect, it } from 'vitest';

import { parseEnvFile } from '@/main/extensions/env-file';

describe('parseEnvFile', () => {
  it('parses simple KEY=VALUE pairs', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores blank lines', () => {
    const result = parseEnvFile('A=1\n\n\nB=2');
    expect(result).toEqual({ A: '1', B: '2' });
  });

  it('ignores comment lines starting with #', () => {
    const result = parseEnvFile('# this is a comment\nKEY=val\n# another');
    expect(result).toEqual({ KEY: 'val' });
  });

  it('ignores lines without equals sign', () => {
    const result = parseEnvFile('NOEQUALS\nKEY=val');
    expect(result).toEqual({ KEY: 'val' });
  });

  it('skips lines with empty key', () => {
    const result = parseEnvFile('=value\nKEY=val');
    expect(result).toEqual({ KEY: 'val' });
  });

  it('allows empty value', () => {
    const result = parseEnvFile('EMPTY=');
    expect(result).toEqual({ EMPTY: '' });
  });

  it('preserves value with equals signs', () => {
    // Only the first = is the delimiter
    const result = parseEnvFile('URL=http://host?a=1&b=2');
    expect(result).toEqual({ URL: 'http://host?a=1&b=2' });
  });

  it('does NOT strip quotes from values (per docstring)', () => {
    const result = parseEnvFile('QUOTED="hello world"');
    expect(result).toEqual({ QUOTED: '"hello world"' });
  });

  it('trims key whitespace', () => {
    const result = parseEnvFile('  KEY  =value');
    expect(result).toEqual({ KEY: 'value' });
  });

  it('preserves leading whitespace in value', () => {
    // The value after the first = is taken as-is (no trim on value)
    const result = parseEnvFile('KEY=  spaced');
    expect(result).toEqual({ KEY: '  spaced' });
  });

  it('handles Windows-style line endings', () => {
    const result = parseEnvFile('A=1\r\nB=2\r\n');
    // \r must be stripped from values to avoid broken API keys / URLs
    expect(result['A']).toBe('1');
    expect(result['B']).toBe('2');
  });

  it('handles empty input', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  it('handles comment with inline # in value', () => {
    // Inline # should NOT be treated as comment — only leading #
    const result = parseEnvFile('URL=http://host#fragment');
    expect(result).toEqual({ URL: 'http://host#fragment' });
  });

  it('last value wins for duplicate keys', () => {
    const result = parseEnvFile('KEY=first\nKEY=second');
    expect(result).toEqual({ KEY: 'second' });
  });
});
