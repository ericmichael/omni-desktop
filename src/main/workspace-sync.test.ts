/**
 * Tests for workspace-sync pure URL helpers.
 *
 * `parseSasUrl`, `sanitizeUrl`, and `fileUrl` are pure string functions
 * with no I/O. `sanitizeUrl` is security-critical — it prevents Azure SAS
 * tokens from leaking into logs.
 */
import { describe, expect, it } from 'vitest';

import { fileUrl, parseSasUrl, sanitizeUrl } from '@/main/workspace-sync';

// ---------------------------------------------------------------------------
// parseSasUrl
// ---------------------------------------------------------------------------

describe('parseSasUrl', () => {
  it('splits a URL on the first question mark', () => {
    const result = parseSasUrl('https://storage.blob.core.windows.net/share?sv=2024&sig=abc');
    expect(result.baseUrl).toBe('https://storage.blob.core.windows.net/share');
    expect(result.sasParams).toBe('sv=2024&sig=abc');
  });

  it('returns empty sasParams for a URL without query string', () => {
    const result = parseSasUrl('https://storage.blob.core.windows.net/share');
    expect(result.baseUrl).toBe('https://storage.blob.core.windows.net/share');
    expect(result.sasParams).toBe('');
  });

  it('handles a URL where the query string starts immediately after ?', () => {
    const result = parseSasUrl('https://example.com?key=val');
    expect(result.baseUrl).toBe('https://example.com');
    expect(result.sasParams).toBe('key=val');
  });

  it('does not split on ? inside the path (only first ? counts)', () => {
    const result = parseSasUrl('https://example.com/path?a=1&b=2?c=3');
    expect(result.baseUrl).toBe('https://example.com/path');
    // Everything after the first ? is sasParams, including the second ?
    expect(result.sasParams).toBe('a=1&b=2?c=3');
  });
});

// ---------------------------------------------------------------------------
// sanitizeUrl — SECURITY
// ---------------------------------------------------------------------------

describe('sanitizeUrl', () => {
  it('redacts a URL containing sig= parameter', () => {
    const url = 'https://storage.blob.core.windows.net/share?sig=abcdef123&sv=2024-11-04';
    expect(sanitizeUrl(url)).toBe('https://storage.blob.core.windows.net/share?[SAS_REDACTED]');
  });

  it('redacts a URL containing sv= parameter', () => {
    const url = 'https://storage.blob.core.windows.net/share?sv=2024-11-04&sig=xyz';
    expect(sanitizeUrl(url)).toBe('https://storage.blob.core.windows.net/share?[SAS_REDACTED]');
  });

  it('redacts a URL containing se= parameter', () => {
    const url = 'https://storage.blob.core.windows.net/share?se=2025-01-01T00:00:00Z&sp=rw';
    expect(sanitizeUrl(url)).toBe('https://storage.blob.core.windows.net/share?[SAS_REDACTED]');
  });

  it('passes through a URL with no SAS parameters unchanged', () => {
    const url = 'https://example.com/path?foo=bar&baz=qux';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('handles SAS tokens embedded in an error message', () => {
    const msg = 'Failed to fetch https://storage.blob.core.windows.net/share?sig=secret123 with status 403';
    const result = sanitizeUrl(msg);
    expect(result).not.toContain('secret123');
    expect(result).toContain('?[SAS_REDACTED]');
    expect(result).toContain('with status 403');
  });

  it('handles a URL with no query string at all', () => {
    const url = 'https://example.com/path';
    expect(sanitizeUrl(url)).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// fileUrl
// ---------------------------------------------------------------------------

describe('fileUrl', () => {
  const parsed = { baseUrl: 'https://storage.blob.core.windows.net/share', sasParams: 'sv=2024&sig=abc' };

  it('builds a URL with encoded path segments and SAS params', () => {
    const result = fileUrl(parsed, 'folder/file.txt');
    expect(result).toBe('https://storage.blob.core.windows.net/share/folder/file.txt?sv=2024&sig=abc');
  });

  it('encodes special characters in path segments', () => {
    const result = fileUrl(parsed, 'my folder/my file (1).txt');
    expect(result).toBe(
      'https://storage.blob.core.windows.net/share/my%20folder/my%20file%20(1).txt?sv=2024&sig=abc'
    );
  });

  it('handles empty relativePath', () => {
    const result = fileUrl(parsed, '');
    expect(result).toBe('https://storage.blob.core.windows.net/share?sv=2024&sig=abc');
  });

  it('prepends extraParams before SAS params', () => {
    const result = fileUrl(parsed, 'file.txt', 'comp=range');
    expect(result).toBe(
      'https://storage.blob.core.windows.net/share/file.txt?comp=range&sv=2024&sig=abc'
    );
  });

  it('handles empty sasParams', () => {
    const noSas = { baseUrl: 'https://example.com', sasParams: '' };
    const result = fileUrl(noSas, 'path');
    expect(result).toBe('https://example.com/path?');
  });
});
