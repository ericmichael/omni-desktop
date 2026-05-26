/**
 * Write-only secret storage for credentials that must never reach the renderer
 * or the `store:changed` snapshot — currently git tokens, keyed by their
 * [[GitCredential]] `id`.
 *
 * The secret bytes live *outside* `StoreData` entirely (a separate encrypted
 * store), so the metadata list (`StoreData.gitCredentials`) can be broadcast to
 * the renderer freely while the tokens stay in the main/server process.
 *
 * Implementations:
 *   - Electron: `ElectronSecretStore` — OS keychain via `safeStorage`, blob in
 *     a dedicated electron-store file (`src/main/secret-store.ts`).
 *   - Server:   `ServerSecretStore` — AES-256-GCM at rest with a server key
 *     (`src/server/secret-store.ts`). The per-tenant cloud variant slots in
 *     behind the same interface.
 */
export interface SecretStore {
  /** Store (or replace) the token for a credential id. */
  setGitToken(id: string, token: string): Promise<void>;
  /** Read a token back — main/server only; never exposed over IPC. */
  getGitToken(id: string): Promise<string | undefined>;
  /** Remove a token. Idempotent. */
  deleteGitToken(id: string): Promise<void>;
}
