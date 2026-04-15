/**
 * Tests for workspace-crypto.ts — AES-256-GCM encrypt/decrypt.
 *
 * Validates round-trip correctness, wire format, tamper detection,
 * version rejection, and edge cases (empty plaintext, wrong key).
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptFile, encryptFile } from '@/main/workspace-crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeKey = () => randomBytes(32);

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('encryptFile / decryptFile', () => {
  it('round-trips arbitrary plaintext', () => {
    const key = makeKey();
    const plaintext = Buffer.from('Hello, world!');
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trips empty plaintext', () => {
    const key = makeKey();
    const plaintext = Buffer.alloc(0);
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trips large plaintext (1 MB)', () => {
    const key = makeKey();
    const plaintext = randomBytes(1024 * 1024);
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trips binary content (all 256 byte values)', () => {
    const key = makeKey();
    const plaintext = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) plaintext[i] = i;
    const encrypted = encryptFile(plaintext, key);
    const decrypted = decryptFile(encrypted, key);

    expect(decrypted).toEqual(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

describe('wire format', () => {
  it('first byte is version 0x01', () => {
    const encrypted = encryptFile(Buffer.from('test'), makeKey());
    expect(encrypted[0]).toBe(0x01);
  });

  it('output is 29 bytes longer than plaintext (1 version + 12 IV + 16 tag)', () => {
    const plaintext = Buffer.from('test');
    const encrypted = encryptFile(plaintext, makeKey());
    expect(encrypted.byteLength).toBe(plaintext.byteLength + 29);
  });

  it('each encryption produces different ciphertext (unique IV)', () => {
    const key = makeKey();
    const plaintext = Buffer.from('same input');
    const a = encryptFile(plaintext, key);
    const b = encryptFile(plaintext, key);

    expect(a.equals(b)).toBe(false);
    expect(decryptFile(a, key)).toEqual(plaintext);
    expect(decryptFile(b, key)).toEqual(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection (GCM authentication)
// ---------------------------------------------------------------------------

describe('tamper detection', () => {
  it('rejects ciphertext with a flipped byte', () => {
    const key = makeKey();
    const plaintext = Buffer.from('secret data here');
    const encrypted = encryptFile(plaintext, key);

    const tampered = Buffer.from(encrypted);
    tampered[30] ^= 0xff;

    expect(() => decryptFile(tampered, key)).toThrow();
  });

  it('rejects ciphertext with a modified auth tag', () => {
    const key = makeKey();
    const encrypted = encryptFile(Buffer.from('secret'), key);

    const tampered = Buffer.from(encrypted);
    tampered[15] ^= 0xff;

    expect(() => decryptFile(tampered, key)).toThrow();
  });

  it('rejects decryption with wrong key', () => {
    const encrypted = encryptFile(Buffer.from('secret'), makeKey());
    expect(() => decryptFile(encrypted, makeKey())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Version enforcement
// ---------------------------------------------------------------------------

describe('version enforcement', () => {
  it('rejects unknown version byte', () => {
    const key = makeKey();
    const encrypted = encryptFile(Buffer.from('test'), key);

    const bad = Buffer.from(encrypted);
    bad[0] = 0x02;

    expect(() => decryptFile(bad, key)).toThrow(/Unsupported encryption version/);
  });

  it('rejects version 0x00 (prevents plaintext downgrade)', () => {
    const key = makeKey();
    const encrypted = encryptFile(Buffer.from('test'), key);

    const bad = Buffer.from(encrypted);
    bad[0] = 0x00;

    expect(() => decryptFile(bad, key)).toThrow(/Unsupported encryption version/);
  });

  it('rejects data shorter than header length (29 bytes)', () => {
    const key = makeKey();

    expect(() => decryptFile(Buffer.alloc(28), key)).toThrow(/too small/);
    expect(() => decryptFile(Buffer.alloc(0), key)).toThrow(/too small/);
  });

  it('accepts data at exactly header length (empty ciphertext)', () => {
    // This is the case of encrypting an empty buffer
    const key = makeKey();
    const encrypted = encryptFile(Buffer.alloc(0), key);
    expect(encrypted.byteLength).toBe(29);
    expect(decryptFile(encrypted, key)).toEqual(Buffer.alloc(0));
  });
});
