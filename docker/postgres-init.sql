-- Runs once on first DB init (as the bootstrap superuser).
--
-- RLS is bypassed by superusers and BYPASSRLS roles, so the app must NOT
-- connect as the bootstrap `omni` superuser. Create a dedicated, unprivileged
-- application role that owns the schema (so it can run migrations and is itself
-- subject to FORCE ROW LEVEL SECURITY). This mirrors how the app authenticates
-- against Azure Database for PostgreSQL with a non-admin role.
CREATE ROLE omni_app WITH LOGIN PASSWORD 'omni' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

GRANT ALL ON DATABASE omni TO omni_app;
ALTER SCHEMA public OWNER TO omni_app;
GRANT ALL ON SCHEMA public TO omni_app;
