/**
 * Server-mode `SecretStore` — git tokens encrypted at rest with AES-256-GCM in
 * a dedicated file (`git-secrets.json`) alongside the server's `config.json`,
 * never part of the `StoreData` snapshot broadcast to browser clients.
 *
 * The encryption key comes from `OMNI_SECRET_KEY` (base64, 32 bytes) when set —
 * the right move for a managed/cloud deploy where the key is provisioned out of
 * band (Key Vault, env). For a self-hosted single-tenant server with no key
 * configured, we generate one and persist it to an owner-only `secret.key` so
 * tokens survive restarts. The multi-tenant cloud variant would key rows by
 * tenant in Postgres behind this same interface.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SecretStore } from '@/shared/secret-store';

const CONFIG_DIR = join(homedir(), '.config', 'Omni Code');
const SECRETS_PATH = join(CONFIG_DIR, 'git-secrets.json');
const KEY_PATH = join(CONFIG_DIR, 'secret.key');

/** `id` → `{ iv, tag, ct }`, all base64. */
type SecretsFile = Record<string, { iv: string; tag: string; ct: string }>;

function loadKey(): Buffer {
  const fromEnv = process.env.OMNI_SECRET_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) {
      throw new Error('OMNI_SECRET_KEY must be 32 bytes (base64-encoded)');
    }
    return key;
  }
  if (existsSync(KEY_PATH)) {
    return Buffer.from(readFileSync(KEY_PATH, 'utf-8').trim(), 'base64');
  }
  const key = randomBytes(32);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_PATH, key.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
  return key;
}

export class ServerSecretStore implements SecretStore {
  private readonly key = loadKey();

  private read(): SecretsFile {
    if (!existsSync(SECRETS_PATH)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(SECRETS_PATH, 'utf-8')) as SecretsFile;
    } catch {
      return {};
    }
  }

  private write(data: SecretsFile): void {
    mkdirSync(dirname(SECRETS_PATH), { recursive: true });
    const tmp = `${SECRETS_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, SECRETS_PATH);
    chmodSync(SECRETS_PATH, 0o600);
  }

  // Crypto + file I/O here are synchronous; the interface is async so the
  // per-tenant Postgres variant can fit behind it, hence explicit Promises.
  setGitToken(id: string, token: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()]);
    const data = this.read();
    data[id] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
    this.write(data);
    return Promise.resolve();
  }

  getGitToken(id: string): Promise<string | undefined> {
    const entry = this.read()[id];
    if (!entry) {
      return Promise.resolve(undefined);
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Promise.resolve(
        Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf-8')
      );
    } catch (err) {
      console.error(`[secret-store] failed to decrypt git token ${id}:`, err);
      return Promise.resolve(undefined);
    }
  }

  deleteGitToken(id: string): Promise<void> {
    const data = this.read();
    if (id in data) {
      delete data[id];
      this.write(data);
    }
    return Promise.resolve();
  }
}
