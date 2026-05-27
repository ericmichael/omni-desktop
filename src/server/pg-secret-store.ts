/**
 * Postgres-backed secret store for cloud/teams mode — durable + RLS-isolated,
 * replacing the ephemeral on-disk {@link ServerSecretStore} (a single file on
 * the App Service container's non-durable disk).
 *
 * Two scopes, both encrypted at rest with AES-256-GCM under `OMNI_SECRET_KEY`:
 *   - **user secrets** (`user_secrets`, keyed by principal + cred id) — git /
 *     github tokens. They are U-identity: resolved against the launching
 *     principal so agent pushes carry that developer's own identity.
 *   - **team secrets** (`team_secrets`, keyed by team + ref name) — shared model
 *     / MCP keys, admin-rotated, masked in the UI.
 *
 * Each operation runs in a scoped transaction (`app.current_principal` /
 * `app.current_tenant`) so the FORCE-RLS policies apply on the omni_app pool.
 * `forPrincipal()` adapts this to the per-(id) {@link SecretStore} interface the
 * existing git-credential handlers consume.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { SecretStore } from '@/shared/secret-store';

function loadKey(): Buffer {
  const fromEnv = process.env['OMNI_SECRET_KEY'];
  if (!fromEnv) {
    throw new Error('[pg-secret-store] OMNI_SECRET_KEY is required in cloud mode (base64, 32 bytes)');
  }
  const key = Buffer.from(fromEnv, 'base64');
  if (key.length !== 32) {
    throw new Error('[pg-secret-store] OMNI_SECRET_KEY must decode to 32 bytes');
  }
  return key;
}

/** `iv.tag.ct` base64 triplet, like ServerSecretStore but stored in one column. */
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

function decrypt(key: Buffer, blob: string): string | undefined {
  const [ivB64, tagB64, ctB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !ctB64) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    return undefined;
  }
}

export class PgSecretStore {
  private readonly key: Buffer;

  constructor(private readonly pool: Pool) {
    this.key = loadKey();
  }

  private async principalTx<T>(principalId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_principal', $1, true)", [principalId]);
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* surface original */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async tenantTx<T>(teamId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [teamId]);
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* surface original */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- User (git/github) secrets, keyed by principal ----

  async setUserGitToken(principalId: string, credId: string, token: string): Promise<void> {
    const ct = encrypt(this.key, token);
    await this.principalTx(principalId, (c) =>
      c.query(
        `INSERT INTO user_secrets (principal_id, cred_id, ciphertext) VALUES ($1, $2, $3)
         ON CONFLICT (principal_id, cred_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [principalId, credId, ct]
      )
    );
  }

  async getUserGitToken(principalId: string, credId: string): Promise<string | undefined> {
    return this.principalTx(principalId, async (c) => {
      const r = await c.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM user_secrets WHERE principal_id = $1 AND cred_id = $2',
        [principalId, credId]
      );
      const blob = r.rows[0]?.ciphertext;
      return blob ? decrypt(this.key, blob) : undefined;
    });
  }

  async deleteUserGitToken(principalId: string, credId: string): Promise<void> {
    await this.principalTx(principalId, (c) =>
      c.query('DELETE FROM user_secrets WHERE principal_id = $1 AND cred_id = $2', [principalId, credId])
    );
  }

  // ---- Team (shared model/MCP) secrets, keyed by team ----

  async setTeamSecret(teamId: string, refName: string, value: string): Promise<void> {
    const ct = encrypt(this.key, value);
    await this.tenantTx(teamId, (c) =>
      c.query(
        `INSERT INTO team_secrets (team_id, ref_name, ciphertext) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, ref_name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [teamId, refName, ct]
      )
    );
  }

  async getTeamSecret(teamId: string, refName: string): Promise<string | undefined> {
    return this.tenantTx(teamId, async (c) => {
      const r = await c.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM team_secrets WHERE team_id = $1 AND ref_name = $2',
        [teamId, refName]
      );
      const blob = r.rows[0]?.ciphertext;
      return blob ? decrypt(this.key, blob) : undefined;
    });
  }

  async deleteTeamSecret(teamId: string, refName: string): Promise<void> {
    await this.tenantTx(teamId, (c) =>
      c.query('DELETE FROM team_secrets WHERE team_id = $1 AND ref_name = $2', [teamId, refName])
    );
  }

  /** Adapt to the per-(id) {@link SecretStore} interface for a fixed principal. */
  forPrincipal(principalId: string): SecretStore {
    return {
      setGitToken: (id, token) => this.setUserGitToken(principalId, id, token),
      getGitToken: (id) => this.getUserGitToken(principalId, id),
      deleteGitToken: (id) => this.deleteUserGitToken(principalId, id),
    };
  }
}
