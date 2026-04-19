import { describe, expect, it } from 'vitest';

import { BROWSER_START_URL, fallbackTitle, normalizeAddress, parseOrigin } from '@/lib/url';

describe('normalizeAddress', () => {
  it('returns the start URL on empty input', () => {
    expect(normalizeAddress('')).toBe(BROWSER_START_URL);
    expect(normalizeAddress('   ')).toBe(BROWSER_START_URL);
  });

  it('passes through known schemes unchanged', () => {
    expect(normalizeAddress('https://example.com')).toBe('https://example.com');
    expect(normalizeAddress('http://example.com')).toBe('http://example.com');
    expect(normalizeAddress('file:///tmp/x.html')).toBe('file:///tmp/x.html');
    expect(normalizeAddress('about:blank')).toBe('about:blank');
    expect(normalizeAddress('view-source:https://a.b')).toBe('view-source:https://a.b');
  });

  it('treats whitespace as a search query', () => {
    expect(normalizeAddress('hello world')).toBe('https://duckduckgo.com/?q=hello%20world');
    expect(normalizeAddress('foo bar.com')).toContain('duckduckgo.com/?q=');
  });

  it('http:// for localhost, IPs, and host:port', () => {
    expect(normalizeAddress('localhost')).toBe('http://localhost');
    expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeAddress('localhost:3000/foo')).toBe('http://localhost:3000/foo');
    expect(normalizeAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAddress('192.168.1.1')).toBe('http://192.168.1.1');
    expect(normalizeAddress('myserver:8080/x')).toBe('http://myserver:8080/x');
  });

  it('handles bracketed IPv6 literals', () => {
    expect(normalizeAddress('[::1]')).toBe('http://[::1]');
    expect(normalizeAddress('[::1]:8080')).toBe('http://[::1]:8080');
    expect(normalizeAddress('[2001:db8::1]:443/foo')).toBe('http://[2001:db8::1]:443/foo');
  });

  it('https:// for bare dotted hostnames', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com');
    expect(normalizeAddress('sub.example.co.uk/path')).toBe('https://sub.example.co.uk/path');
  });

  it('falls back to DDG search for bare terms', () => {
    expect(normalizeAddress('hello')).toBe('https://duckduckgo.com/?q=hello');
  });
});

describe('parseOrigin', () => {
  it('extracts scheme/host and reports security', () => {
    expect(parseOrigin('https://example.com/foo')).toEqual({ scheme: 'https', host: 'example.com', secure: true });
    expect(parseOrigin('http://example.com')).toEqual({ scheme: 'http', host: 'example.com', secure: false });
    expect(parseOrigin('not a url')).toBe(null);
  });
});

describe('fallbackTitle', () => {
  it('uses host when possible', () => {
    expect(fallbackTitle('https://example.com/foo')).toBe('example.com');
    expect(fallbackTitle('not a url')).toBe('not a url');
  });
});
