/**
 * Postgres least-privilege bootstrap + RLS enforcement guard for cloud mode.
 *
 * The deployed Postgres Flexible Server is private (VNet-only), so the operator
 * cannot reach it from a laptop to run role SQL — the launcher container, which
 * IS VNet-integrated, bootstraps the application role itself on boot.
 *
 * Posture:
 *   - The app's normal pool connects as a non-superuser, NOBYPASSRLS role
 *     (`omni_app`) via `OMNI_DATABASE_URL`. Because it is neither a superuser,
 *     a BYPASSRLS role, nor the table owner, the row-level-security policies are
 *     physically enforced on every query — tenant (team) isolation cannot be
 *     bypassed by a forgotten predicate.
 *   - `OMNI_DATABASE_ADMIN_URL` (the server admin) is used ONLY at boot to
 *     create/repair `omni_app`, grant it DML, set default privileges so future
 *     migration tables auto-grant, and run migrations (as the owner so RLS
 *     applies to `omni_app`).
 *   - {@link assertNonBypassingRole} is a fail-closed boot guard: if the normal
 *     pool somehow connects as a superuser / BYPASSRLS role, the server refuses
 *     to start rather than silently serving every tenant's data to everyone.
 */
import { Client, type Pool } from 'pg';

/** The fixed application role name. Not user input — safe to inline in DDL. */
export const APP_ROLE = 'omni_app';

/** node-postgres rejects managed-CA certs under `sslmode=require`; drive TLS via ssl config instead. */
function adminClientConfig(url: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  const wantsTls = /[?&](sslmode=(require|verify-ca|verify-full|prefer)|ssl=true)/.test(url);
  if (!wantsTls) {
    return { connectionString: url };
  }
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('ssl');
    return { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  } catch {
    return { connectionString: url, ssl: { rejectUnauthorized: false } };
  }
}

/** Extract the password from a `postgresql://user:pw@host/...` URL (the omni_app DSN). */
function passwordFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

/**
 * Ensure the `omni_app` role exists with the password baked into `appUrl`,
 * grant it DML on the public schema, and set default privileges so tables
 * created by later migrations (run as the admin owner) auto-grant to it.
 * Idempotent. Connects as the admin (`adminUrl`).
 */
export async function ensureAppRole(adminUrl: string, appUrl: string): Promise<void> {
  const password = passwordFromUrl(appUrl);
  if (!password) {
    throw new Error('[pg-bootstrap] OMNI_DATABASE_URL has no password to provision the omni_app role with');
  }
  const lit = `'${password.replace(/'/g, "''")}'`;
  const client = new Client(adminClientConfig(adminUrl));
  await client.connect();
  try {
    // CREATE path: full attribute set, settable by a CREATEROLE-holding admin
    // (works on first deploy when the role doesn't exist yet).
    //
    // ALTER path: SET ONLY THE PASSWORD. On Azure PG Flexible Server the
    // admin role lacks SUPERUSER, and Postgres requires SUPERUSER to *change*
    // the SUPERUSER attribute — even when setting it to its current value.
    // Including NOSUPERUSER/NOBYPASSRLS on a re-deploy fails with 42501
    // (permission denied to alter role) and crashloops the launcher. The
    // attributes were locked in at CREATE time and on Azure Flex can't be
    // escalated anyway, so the ALTER is purely a password sync.
    await client.query(`DO $do$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${lit};
      ELSE
        ALTER ROLE ${APP_ROLE} PASSWORD ${lit};
      END IF;
    END $do$;`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    // Default privileges (FOR the current admin role) so tables/sequences the
    // admin creates in later migrations are automatically usable by omni_app.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}

/**
 * Grant DML on all currently-existing tables/sequences to `omni_app`. Run AFTER
 * migrations so it catches tables created before default privileges existed
 * (upgrades) as well as the freshly-created ones. Idempotent.
 */
export async function grantAppPrivileges(adminUrl: string): Promise<void> {
  const client = new Client(adminClientConfig(adminUrl));
  await client.connect();
  try {
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  } finally {
    await client.end();
  }
}

/**
 * Bootstrap the sibling `omni_sessions` database for omniagents' PG history
 * backend. Connects as admin against the sessions DB and:
 *   - grants USAGE + CREATE on schema public to omni_app (so the omniagents
 *     PgSessionStorage can CREATE TABLE IF NOT EXISTS on its first connect),
 *   - sets default privileges so any tables omni_app later creates auto-grant
 *     DML back to itself (no-op in single-role mode, but future-proof if a
 *     separate sessions-owner role is introduced).
 *
 * Idempotent. omni_app is assumed to already exist (created by ensureAppRole
 * against the main DB; PG roles are server-scoped, so the same role works
 * across databases).
 */
export async function ensureSessionsDb(sessionsAdminUrl: string): Promise<void> {
  const client = new Client(adminClientConfig(sessionsAdminUrl));
  await client.connect();
  try {
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${APP_ROLE} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${APP_ROLE} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`
    );
  } finally {
    await client.end();
  }
}

/**
 * Fail-closed guard: throw if the pool's role can bypass row-level security
 * (superuser or BYPASSRLS). Multi-tenant isolation rests entirely on RLS being
 * enforced, so a bypassing connection must never serve traffic.
 */
export async function assertNonBypassingRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ super: boolean; bypass: boolean }>(
    `SELECT current_setting('is_superuser')::bool AS super,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass`
  );
  const row = rows[0];
  if (!row) {
    throw new Error('[pg-bootstrap] could not determine the connected role privileges');
  }
  if (row.super || row.bypass) {
    throw new Error(
      `[pg-bootstrap] REFUSING TO START: the app database role bypasses row-level security ` +
        `(superuser=${row.super}, bypassrls=${row.bypass}). Point OMNI_DATABASE_URL at the ` +
        `non-superuser '${APP_ROLE}' role — multi-tenant isolation depends on RLS enforcement.`
    );
  }
}
