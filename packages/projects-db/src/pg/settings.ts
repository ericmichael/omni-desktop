/**
 * Per-tenant settings load/save against the `user_settings` JSONB table.
 *
 * Kept generic (a `Record<string, unknown>` blob) so the `pg` driver stays
 * confined to this package; the launcher's `PgSettingsStore` layers the
 * `StoreData` shape + in-memory cache on top. Each call runs in a
 * tenant-scoped transaction so row-level security applies.
 */
import type { Pool, PoolClient } from 'pg';

async function tenantTx<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  originId = ''
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_origin', $1, true)", [originId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // surface the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read a tenant's settings blob, or null if it has none yet. */
export function loadTenantSettings(pool: Pool, tenantId: string): Promise<Record<string, unknown> | null> {
  return tenantTx(pool, tenantId, async (c) => {
    const r = await c.query('SELECT data FROM user_settings WHERE tenant_id = $1', [tenantId]);
    return (r.rows[0]?.data ?? null) as Record<string, unknown> | null;
  });
}

// ---- Teams: split settings (team_settings + user_settings_v2) ----
//
// team_settings is RLS-scoped by app.current_tenant (= team id); user_settings_v2
// by app.current_principal. Each runs in its own scoped tx so FORCE RLS applies.

async function principalTx<T>(
  pool: Pool,
  principalId: string,
  fn: (client: PoolClient) => Promise<T>,
  originId = ''
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_principal', $1, true)", [principalId]);
    await client.query("SELECT set_config('app.current_origin', $1, true)", [originId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // surface the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read a team's settings-base blob (team_settings), or null if none yet. */
export function loadTeamSettings(pool: Pool, teamId: string): Promise<Record<string, unknown> | null> {
  return tenantTx(pool, teamId, async (c) => {
    const r = await c.query('SELECT data FROM team_settings WHERE team_id = $1', [teamId]);
    return (r.rows[0]?.data ?? null) as Record<string, unknown> | null;
  });
}

/** Upsert a team's settings-base blob (full-document write-through). */
export async function saveTeamSettings(
  pool: Pool,
  teamId: string,
  data: Record<string, unknown>,
  originId = ''
): Promise<void> {
  await tenantTx(
    pool,
    teamId,
    (c) =>
      c.query(
        `INSERT INTO team_settings (team_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (team_id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [teamId, JSON.stringify(data)]
      ),
    originId
  );
}

/** Read a principal's overlay blob (user_settings_v2), or null if none yet. */
export function loadUserSettings(pool: Pool, principalId: string): Promise<Record<string, unknown> | null> {
  return principalTx(pool, principalId, async (c) => {
    const r = await c.query('SELECT data FROM user_settings_v2 WHERE principal_id = $1', [principalId]);
    return (r.rows[0]?.data ?? null) as Record<string, unknown> | null;
  });
}

/** Upsert a principal's overlay blob (full-document write-through). */
export async function saveUserSettings(
  pool: Pool,
  principalId: string,
  data: Record<string, unknown>,
  originId = ''
): Promise<void> {
  await principalTx(
    pool,
    principalId,
    (c) =>
      c.query(
        `INSERT INTO user_settings_v2 (principal_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (principal_id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [principalId, JSON.stringify(data)]
      ),
    originId
  );
}

/** Read the legacy single-blob user_settings row (for one-time per-principal migration). */
export function loadLegacyUserSettings(pool: Pool, principalId: string): Promise<Record<string, unknown> | null> {
  return loadTenantSettings(pool, principalId);
}

/** Upsert a tenant's settings blob (full-document write-through). */
export async function saveTenantSettings(
  pool: Pool,
  tenantId: string,
  data: Record<string, unknown>,
  originId = ''
): Promise<void> {
  await tenantTx(
    pool,
    tenantId,
    (c) =>
      c.query(
        `INSERT INTO user_settings (tenant_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (tenant_id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
        [tenantId, JSON.stringify(data)]
      ),
    originId
  );
}
