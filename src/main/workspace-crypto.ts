/**
 * Client-side encryption for workspace files using AES-256-GCM.
 *
 * File format: [1-byte version][12-byte IV][16-byte auth tag][ciphertext]
 *
 * Version 0x01 = AES-256-GCM (only supported version)
 *
 * The encryption key is a 256-bit key derived by the platform via HKDF
 * from a master secret + project ID. It's vended over TLS and held in
 * memory only.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION_AES_GCM = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH; // 29 bytes

/**
 * Encrypt a file buffer with AES-256-GCM.
 * Returns: [version=0x01][iv:12][tag:16][ciphertext]
 */
export function encryptFile(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // version + iv + tag + ciphertext
  const result = Buffer.allocUnsafe(HEADER_LENGTH + encrypted.byteLength);
  result[0] = VERSION_AES_GCM;
  iv.copy(result, 1);
  tag.copy(result, 1 + IV_LENGTH);
  encrypted.copy(result, HEADER_LENGTH);

  return result;
}

/**
 * Decrypt a file buffer. Rejects anything that isn't AES-256-GCM (version 0x01).
 * This prevents downgrade attacks where an attacker replaces encrypted files with plaintext.
 */
export function decryptFile(data: Buffer, key: Buffer): Buffer {
  if (data.byteLength < HEADER_LENGTH) {
    throw new Error('File is too small to be encrypted — possible tampering or corruption');
  }

  const version = data[0];

  if (version !== VERSION_AES_GCM) {
    throw new Error(`Unsupported encryption version 0x${version?.toString(16).padStart(2, '0')} — refusing to process`);
  }

  const iv = data.subarray(1, 1 + IV_LENGTH);
  const tag = data.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = data.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
