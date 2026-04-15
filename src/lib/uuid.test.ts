/**
 * Tests for uuid.ts — v4 UUID generation.
 * Validates format compliance, version/variant bits, and uniqueness.
 */
import { describe, expect, it } from 'vitest';

import { uuidv4 } from '@/lib/uuid';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv4', () => {
  it('returns a string in valid UUID v4 format', () => {
    expect(uuidv4()).toMatch(UUID_V4_REGEX);
  });

  it('has version nibble = 4', () => {
    const uuid = uuidv4();
    // 15th character (0-indexed 14) should be '4'
    expect(uuid[14]).toBe('4');
  });

  it('has variant bits in [8, 9, a, b]', () => {
    const uuid = uuidv4();
    // 20th character (0-indexed 19) should be one of 8/9/a/b
    expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
  });

  it('generates unique values', () => {
    const uuids = new Set(Array.from({ length: 100 }, () => uuidv4()));
    expect(uuids.size).toBe(100);
  });

  it('is exactly 36 characters long', () => {
    expect(uuidv4().length).toBe(36);
  });

  it('uses lowercase hex', () => {
    const uuid = uuidv4();
    expect(uuid).toBe(uuid.toLowerCase());
  });
});
