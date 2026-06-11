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
 *   - Local: `LocalSecretStore` — AES-256-GCM at rest in a shared
 *     `git-secrets.json` (`src/main/secret-store.ts`), used by BOTH the Electron
 *     desktop shell and local single-tenant server mode, so a credential linked
 *     in one shell is usable in the other (`src/server/secret-store.ts`
 *     re-exports it as `ServerSecretStore`).
 *   - Cloud: `PgSecretStore` — per-tenant rows in Postgres, behind the same
 *     interface.
 */
export interface SecretStore {
  /** Store (or replace) the token for a credential id. */
  setGitToken(id: string, token: string): Promise<void>;
  /** Read a token back — main/server only; never exposed over IPC. */
  getGitToken(id: string): Promise<string | undefined>;
  /** Remove a token. Idempotent. */
  deleteGitToken(id: string): Promise<void>;
}
