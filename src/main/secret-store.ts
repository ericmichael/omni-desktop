/**
 * Local `SecretStore` — shared by the Electron desktop shell and local
 * (single-tenant) server mode, so a credential linked in one is usable in the
 * other. Like the rest of the local data model (`config.json`, projects), the
 * secret file is shared; only the cloud/multi-tenant path diverges (Postgres,
 * `PgSecretStore`).
 *
 * Storage: AES-256-GCM at rest in `~/.config/Omni Code/git-secrets.json`, keyed
 * by `OMNI_SECRET_KEY` (base64, 32 bytes) when set, else a generated owner-only
 * `secret.key` alongside it. No Electron `safeStorage` dependency — that's why
 * the same implementation runs in both shells (server mode has no Electron), and
 * it gives real encryption at rest even on Linux boxes with no OS keyring (where
 * `safeStorage` silently degraded to plaintext).
 *
 * Two slots in the file:
 *   - `gitTokens`   — single-string tokens (the {@link SecretStore} interface).
 *   - `oauthTokens` — opaque JSON bundles (Entra/codex access+refresh+expires).
 *
 * Back-compat: older entries written by the previous Electron store use a
 * `{ v, enc }` envelope (`enc:true` = `safeStorage`-encrypted, `enc:false` =
 * base64 plaintext). We still READ those — `enc:false` decodes directly;
 * `enc:true` can't be decrypted without `safeStorage` (warned, treated as
 * absent). Any subsequent write re-saves the entry in the AES format, so the
 * file upgrades itself in place.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SecretStore } from '@/shared/secret-store';

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'Omni Code');

/** AES-256-GCM envelope (current format). */
type AesBlob = { iv: string; tag: string; ct: string };
/** Legacy Electron-store envelope (read-only; `enc:true` needs safeStorage). */
type LegacyBlob = { v: string; enc: boolean };
type Blob = AesBlob | LegacyBlob;

type SecretsFile = {
  gitTokens: Record<string, Blob>;
  oauthTokens: Record<string, Blob>;
};

function isAesBlob(b: Blob): b is AesBlob {
  return 'iv' in b;
}

export class LocalSecretStore implements SecretStore {
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private _key: Buffer | undefined;

  /** `configDir` defaults to the shared local config dir; overridable for tests. */
  constructor(private readonly configDir: string = DEFAULT_CONFIG_DIR) {
    this.secretsPath = join(configDir, 'git-secrets.json');
    this.keyPath = join(configDir, 'secret.key');
  }

  private key(): Buffer {
    if (this._key) {
      return this._key;
    }
    const fromEnv = process.env.OMNI_SECRET_KEY;
    if (fromEnv) {
      const key = Buffer.from(fromEnv, 'base64');
      if (key.length !== 32) {
        throw new Error('OMNI_SECRET_KEY must be 32 bytes (base64-encoded)');
      }
      return (this._key = key);
    }
    if (existsSync(this.keyPath)) {
      return (this._key = Buffer.from(readFileSync(this.keyPath, 'utf-8').trim(), 'base64'));
    }
    const key = randomBytes(32);
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.keyPath, key.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
    return (this._key = key);
  }

  private read(): SecretsFile {
    const empty: SecretsFile = { gitTokens: {}, oauthTokens: {} };
    if (!existsSync(this.secretsPath)) {
      return empty;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.secretsPath, 'utf-8')) as Partial<SecretsFile>;
      return { gitTokens: parsed.gitTokens ?? {}, oauthTokens: parsed.oauthTokens ?? {} };
    } catch {
      return empty;
    }
  }

  private write(data: SecretsFile): void {
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    const tmp = `${this.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.secretsPath);
    chmodSync(this.secretsPath, 0o600);
  }

  private encrypt(value: string): AesBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  private decrypt(entry: Blob | undefined, label: string): string | undefined {
    if (!entry) {
      return undefined;
    }
    if (isAesBlob(entry)) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(entry.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf-8');
      } catch (err) {
        console.error(`[secret-store] failed to decrypt ${label}:`, err);
        return undefined;
      }
    }
    // Legacy Electron envelope.
    if (!entry.enc) {
      return Buffer.from(entry.v, 'base64').toString('utf-8');
    }
    console.warn(
      `[secret-store] ${label} was written with OS-keychain encryption by the desktop app and ` +
        `can't be read here; re-link it in Settings to re-save in the shared format`
    );
    return undefined;
  }

  // fs + crypto are synchronous; the interface is async so the Postgres-backed
  // cloud variant fits behind it, hence the explicit Promise returns.
  setGitToken(id: string, token: string): Promise<void> {
    const data = this.read();
    data.gitTokens[id] = this.encrypt(token);
    this.write(data);
    return Promise.resolve();
  }

  getGitToken(id: string): Promise<string | undefined> {
    return Promise.resolve(this.decrypt(this.read().gitTokens[id], `git token ${id}`));
  }

  deleteGitToken(id: string): Promise<void> {
    const data = this.read();
    if (id in data.gitTokens) {
      delete data.gitTokens[id];
      this.write(data);
    }
    return Promise.resolve();
  }

  /** Store an opaque JSON token bundle (e.g. Entra OAuth tokens), encrypted. */
  setOauthTokens(id: string, tokens: Record<string, unknown>): void {
    const data = this.read();
    data.oauthTokens[id] = this.encrypt(JSON.stringify(tokens));
    this.write(data);
  }

  getOauthTokens(id: string): Record<string, unknown> | undefined {
    const plain = this.decrypt(this.read().oauthTokens[id], `oauth tokens ${id}`);
    if (!plain) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(plain) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  deleteOauthTokens(id: string): void {
    const data = this.read();
    if (id in data.oauthTokens) {
      delete data.oauthTokens[id];
      this.write(data);
    }
  }
}

// Shared default instance + free-function facade for the oauth (Entra) callers,
// which predate the class and import these by name.
const defaultStore = new LocalSecretStore();

export function setOauthTokens(id: string, tokens: Record<string, unknown>): void {
  defaultStore.setOauthTokens(id, tokens);
}

export function getOauthTokens(id: string): Record<string, unknown> | undefined {
  return defaultStore.getOauthTokens(id);
}

export function deleteOauthTokens(id: string): void {
  defaultStore.deleteOauthTokens(id);
}
