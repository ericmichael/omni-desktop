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
 * Resolve a connection string + explicit `ssl` config for node-postgres.
 *
 * Managed Postgres (Azure Flexible Server, etc.) requires TLS, signalled by
 * `?sslmode=require` in the URL. BUT node-postgres treats `sslmode=require` as
 * `verify-full` (full cert validation) and that takes precedence over any
 * `ssl` option object — so it rejects the managed CA / a self-signed cert
 * (`DEPTH_ZERO_SELF_SIGNED_CERT`) and the server crashes on boot. So when TLS
 * is requested we STRIP `sslmode`/`ssl` from the URL and drive TLS purely via
 * the `ssl` config (`rejectUnauthorized: false` — encrypted, cert not pinned).
 * No TLS marker → no SSL (local docker Postgres).
 */
function pgConnectConfig(connectionString: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  const wantsTls = /[?&](sslmode=(require|verify-ca|verify-full|prefer)|ssl=true)/.test(connectionString);
  if (!wantsTls) {
    return { connectionString };
  }
  let cleaned = connectionString;
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('ssl');
    cleaned = url.toString();
  } catch {
    // not URL-parseable — leave as-is; the ssl config still applies
  }
  return { connectionString: cleaned, ssl: { rejectUnauthorized: false } };
}

/**
 * Open a dedicated LISTEN connection on `channel` (multi-replica coherence).
 * `onNotify` receives the raw payload string. Returns a stop function. The
 * channel name is a fixed identifier (not user input), so it's safe to inline.
 */
export async function createPgListener(
  connectionString: string,
  channel: string,
  onNotify: (payload: string) => void,
  options: { onReconnect?: () => void; retryDelayMs?: number } = {}
): Promise<() => Promise<void>> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
    throw new Error('Invalid LISTEN channel');
  }
  const conn = pgConnectConfig(connectionString);
  let client: Client | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<void> | undefined;
  let attempts = 0;
  const schedule = (): void => {
    if (stopped || timer) {
      return;
    }
    const delay = Math.min(30_000, (options.retryDelayMs ?? 1000) * 2 ** Math.min(attempts++, 5));
    timer = setTimeout(() => {
      timer = undefined;
      connecting = connect().catch(() => schedule());
    }, delay);
    timer.unref?.();
  };
  const connect = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const next = new Client({ ...conn, connectionTimeoutMillis: 10_000 });
    const previous = client;
    client = next;
    await previous?.end().catch(() => undefined);
    next.on('notification', (msg) => {
      if (!stopped && client === next && msg.channel === channel && msg.payload) {
        try {
          onNotify(msg.payload);
        } catch (err) {
          console.error('[pg-listener] notification failed:', err);
        }
      }
    });
    const lost = (): void => {
      if (client === next) {
        schedule();
      }
    };
    next.on('error', lost);
    next.on('end', lost);
    try {
      await next.connect();
      if (stopped) {
        await next.end();
        return;
      }
      await next.query(`LISTEN ${channel}`);
      attempts = 0;
      // NOTIFY is not durable. Re-subscribe BEFORE refreshing authoritative
      // state, so writes missed while disconnected cannot leave stale caches.
      options.onReconnect?.();
    } catch (error) {
      await next.end().catch(() => undefined);
      throw error;
    }
  };
  try {
    connecting = connect();
    await connecting;
  } catch (error) {
    stopped = true;
    clearTimeout(timer);
    throw error;
  }
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await connecting?.catch(() => undefined);
    await client?.end().catch(() => undefined);
  };
}

/** Create a connection pool. The caller owns its lifecycle (`pool.end()`). */
export function createPgPool(connectionString: string): Pool {
  return new Pool(pgConnectConfig(connectionString));
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
