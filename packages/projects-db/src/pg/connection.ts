/**
 * Postgres pool + migration runner for multi-tenant server mode.
 *
 * Kept separate from the SQLite `connection.ts` so importing the SQLite path
 * never pulls in the `pg` driver. The launcher only loads this module when
 * `OMNI_DATABASE_URL` is set.
 */
import { Client, Pool } from 'pg';

import { pgMigrations } from './schema.js';

export type { Pool } from 'pg';

/**
 * node-postgres does NOT honor `sslmode` from the connection string, so a URL
 * like `…?sslmode=require` connects WITHOUT TLS — which managed Postgres
 * (Azure Flexible Server, etc.) rejects, crashing the server on boot. Derive an
 * explicit `ssl` config from the URL: TLS on for `sslmode=require|verify-*` (or
 * `ssl=true`), off otherwise (local docker Postgres). `rejectUnauthorized:
 * false` accepts the managed CA without bundling it — encrypted, not pinned.
 */
function sslFromConnectionString(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  return /[?&](sslmode=(require|verify-ca|verify-full)|ssl=true)/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
}

/**
 * Open a dedicated LISTEN connection on `channel` (multi-replica coherence).
 * `onNotify` receives the raw payload string. Returns a stop function. The
 * channel name is a fixed identifier (not user input), so it's safe to inline.
 */
export async function createPgListener(
  connectionString: string,
  channel: string,
  onNotify: (payload: string) => void
): Promise<() => Promise<void>> {
  const client = new Client({ connectionString, ssl: sslFromConnectionString(connectionString) });
  await client.connect();
  client.on('notification', (msg) => {
    if (msg.channel === channel && msg.payload) {
      onNotify(msg.payload);
    }
  });
  // Auto-recover the listener if the connection drops.
  client.on('error', (err) => {
    console.error('[pg-listener] connection error:', err.message);
  });
  await client.query(`LISTEN ${channel}`);
  return async () => {
    try {
      await client.end();
    } catch {
      // already closed
    }
  };
}

/** Create a connection pool. The caller owns its lifecycle (`pool.end()`). */
export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString, ssl: sslFromConnectionString(connectionString) });
}

/** Fixed key for the migration advisory lock (so concurrent replicas serialize). */
const MIGRATION_LOCK_KEY = 727274;

/**
 * Apply pending migrations in a transaction each, tracked in `_pg_migrations`.
 * Idempotent and concurrency-safe: a session-level advisory lock serializes
 * replicas booting together, so only one applies and the rest see the version
 * already current and skip.
 */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await lock.query(
      `CREATE TABLE IF NOT EXISTS _pg_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await lock.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM _pg_migrations');
    const current = Number(rows[0]?.v ?? 0);

    for (const m of pgMigrations) {
      if (m.version <= current) {
        continue;
      }
      try {
        await lock.query('BEGIN');
        await lock.query(m.sql);
        await lock.query('INSERT INTO _pg_migrations (version) VALUES ($1)', [m.version]);
        await lock.query('COMMIT');
      } catch (err) {
        await lock.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    lock.release();
  }
}
