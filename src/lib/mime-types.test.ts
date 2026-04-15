/**
 * Tests for mime-types.ts — MIME type lookup and text detection.
 */
import { describe, expect, it } from 'vitest';

import { getMimeType, isTextMime } from '@/lib/mime-types';

describe('getMimeType', () => {
  it('returns the correct MIME for known extensions', () => {
    expect(getMimeType('file.png')).toBe('image/png');
    expect(getMimeType('style.css')).toBe('text/css');
    expect(getMimeType('app.ts')).toBe('text/typescript');
    expect(getMimeType('data.json')).toBe('application/json');
    expect(getMimeType('script.py')).toBe('text/x-python');
    expect(getMimeType('readme.md')).toBe('text/markdown');
    expect(getMimeType('archive.zip')).toBe('application/zip');
    expect(getMimeType('video.mp4')).toBe('video/mp4');
  });

  it('is case-insensitive for extensions', () => {
    expect(getMimeType('IMAGE.PNG')).toBe('image/png');
    expect(getMimeType('FILE.JSON')).toBe('application/json');
    expect(getMimeType('Test.Md')).toBe('text/markdown');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('data.foo')).toBe('application/octet-stream');
  });

  it('returns octet-stream for files with no extension', () => {
    expect(getMimeType('Makefile')).toBe('application/octet-stream');
    expect(getMimeType('LICENSE')).toBe('application/octet-stream');
  });

  it('uses the last dot for extension (handles dotfiles)', () => {
    expect(getMimeType('.gitignore')).toBe('application/octet-stream');
    expect(getMimeType('file.backup.txt')).toBe('text/plain');
  });

  it('handles paths with directories', () => {
    expect(getMimeType('src/lib/module.ts')).toBe('text/typescript');
    expect(getMimeType('/home/user/file.json')).toBe('application/json');
  });
});

describe('isTextMime', () => {
  it('returns true for text/* MIME types', () => {
    expect(isTextMime('text/plain')).toBe(true);
    expect(isTextMime('text/html')).toBe(true);
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('text/typescript')).toBe(true);
    expect(isTextMime('text/x-python')).toBe(true);
  });

  it('returns true for application/json', () => {
    expect(isTextMime('application/json')).toBe(true);
  });

  it('returns false for binary MIME types', () => {
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('application/zip')).toBe(false);
    expect(isTextMime('application/pdf')).toBe(false);
    expect(isTextMime('video/mp4')).toBe(false);
    expect(isTextMime('application/octet-stream')).toBe(false);
  });
});
