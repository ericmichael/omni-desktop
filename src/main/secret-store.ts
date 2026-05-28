/**
 * Electron `SecretStore` — git tokens encrypted with the OS keychain via
 * `safeStorage` and held in a dedicated electron-store file (`git-secrets`),
 * kept out of the main `StoreData` so secrets never enter the `store:changed`
 * snapshot the renderer mirrors.
 *
 * `safeStorage` is backed by Keychain (macOS), DPAPI (Windows), or
 * libsecret/kwallet (Linux). When no backend is available (some headless Linux
 * setups), we fall back to storing the raw token in the owner-only userData
 * file — no worse than the sibling `codex.json` token store, and loudly logged.
 */
import { safeStorage } from 'electron';
import Store from 'electron-store';

import type { SecretStore } from '@/shared/secret-store';

type EncryptedBlob = { v: string; enc: boolean };

type SecretsSchema = {
  /** `id` → encrypted token bytes (b64). */
  gitTokens: Record<string, EncryptedBlob>;
  /**
   * `id` → encrypted JSON blob (b64). Holds opaque OAuth token bundles
   * (e.g. Entra access+refresh+expires) that don't fit the single-string
   * shape of {@link SecretStore}. Same envelope as gitTokens, separate slot
   * so a corrupt entry on one side doesn't take out the other.
   */
  oauthTokens: Record<string, EncryptedBlob>;
};

let _store: Store<SecretsSchema> | undefined;

function getSecretsStore(): Store<SecretsSchema> {
  if (!_store) {
    _store = new Store<SecretsSchema>({
      name: 'git-secrets',
      clearInvalidConfig: true,
      defaults: { gitTokens: {}, oauthTokens: {} },
    });
  }
  return _store;
}

function encryptString(value: string): EncryptedBlob {
  if (safeStorage.isEncryptionAvailable()) {
    return { v: safeStorage.encryptString(value).toString('base64'), enc: true };
  }
  console.warn('[secret-store] OS encryption unavailable — storing secret unencrypted in userData');
  return { v: Buffer.from(value, 'utf-8').toString('base64'), enc: false };
}

function decryptBlob(entry: EncryptedBlob | undefined): string | undefined {
  if (!entry) return undefined;
  const buf = Buffer.from(entry.v, 'base64');
  if (!entry.enc) return buf.toString('utf-8');
  try {
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.error('[secret-store] failed to decrypt secret:', err);
    return undefined;
  }
}

export class ElectronSecretStore implements SecretStore {
  // safeStorage is synchronous; the interface is async so a DB-backed server
  // variant can fit behind it, hence the explicit Promise returns.
  setGitToken(id: string, token: string): Promise<void> {
    const store = getSecretsStore();
    const tokens = { ...store.get('gitTokens') };
    tokens[id] = encryptString(token);
    store.set('gitTokens', tokens);
    return Promise.resolve();
  }

  getGitToken(id: string): Promise<string | undefined> {
    return Promise.resolve(decryptBlob(getSecretsStore().get('gitTokens')[id]));
  }

  deleteGitToken(id: string): Promise<void> {
    const store = getSecretsStore();
    const tokens = { ...store.get('gitTokens') };
    if (id in tokens) {
      delete tokens[id];
      store.set('gitTokens', tokens);
    }
    return Promise.resolve();
  }
}

/**
 * Store an opaque JSON token bundle (e.g. Entra ID OAuth tokens) under
 * *id*, encrypted the same way as git tokens.
 */
export function setOauthTokens(id: string, tokens: Record<string, unknown>): void {
  const store = getSecretsStore();
  const map = { ...store.get('oauthTokens') };
  map[id] = encryptString(JSON.stringify(tokens));
  store.set('oauthTokens', map);
}

export function getOauthTokens(id: string): Record<string, unknown> | undefined {
  const plain = decryptBlob(getSecretsStore().get('oauthTokens')[id]);
  if (!plain) return undefined;
  try {
    const parsed = JSON.parse(plain) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function deleteOauthTokens(id: string): void {
  const store = getSecretsStore();
  const map = { ...store.get('oauthTokens') };
  if (id in map) {
    delete map[id];
    store.set('oauthTokens', map);
  }
}
