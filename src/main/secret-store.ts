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

type SecretsSchema = {
  /** `id` → base64 of (encrypted, or plaintext when `enc` is false) token bytes. */
  gitTokens: Record<string, { v: string; enc: boolean }>;
};

let _store: Store<SecretsSchema> | undefined;

function getSecretsStore(): Store<SecretsSchema> {
  if (!_store) {
    _store = new Store<SecretsSchema>({
      name: 'git-secrets',
      clearInvalidConfig: true,
      defaults: { gitTokens: {} },
    });
  }
  return _store;
}

export class ElectronSecretStore implements SecretStore {
  // safeStorage is synchronous; the interface is async so a DB-backed server
  // variant can fit behind it, hence the explicit Promise returns.
  setGitToken(id: string, token: string): Promise<void> {
    const store = getSecretsStore();
    const tokens = { ...store.get('gitTokens') };
    if (safeStorage.isEncryptionAvailable()) {
      tokens[id] = { v: safeStorage.encryptString(token).toString('base64'), enc: true };
    } else {
      console.warn('[secret-store] OS encryption unavailable — storing git token unencrypted in userData');
      tokens[id] = { v: Buffer.from(token, 'utf-8').toString('base64'), enc: false };
    }
    store.set('gitTokens', tokens);
    return Promise.resolve();
  }

  getGitToken(id: string): Promise<string | undefined> {
    const entry = getSecretsStore().get('gitTokens')[id];
    if (!entry) {
      return Promise.resolve(undefined);
    }
    const buf = Buffer.from(entry.v, 'base64');
    if (!entry.enc) {
      return Promise.resolve(buf.toString('utf-8'));
    }
    try {
      return Promise.resolve(safeStorage.decryptString(buf));
    } catch (err) {
      console.error(`[secret-store] failed to decrypt git token ${id}:`, err);
      return Promise.resolve(undefined);
    }
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
