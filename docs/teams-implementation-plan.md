# Teams implementation plan (Azure/cloud only)

Status: design, decision-complete, not yet implemented. Companion to `docs/teams-settings-merge.md` (the settings layer/merge spec — source of truth for per-key placement). Electron + local-server modes are **unchanged** (single-user); the SQLite `: store` branch is untouched by construction.

## 0. Verified architecture facts (corrections in **bold**)

- Cloud gated by `OMNI_DATABASE_URL` → `PgProjectsRepo(pool, tenantId, originId)`, per-tx `set_config('app.current_tenant', …)`. RLS `ENABLE`+`FORCE`, policy on `current_setting('app.current_tenant', true)` (the `true` = missing_ok → unset GUC denies all rows, **fail-closed**).
- **Current PG schema version is 5** (`pg/schema.ts` `pgMigrations` ends at v5). New migrations start at **v6**.
- `runPgMigrations` advisory lock `727274`, tracked in `_pg_migrations`.
- `resolveTenantId` (`index.ts:51-60`) trusts `x-ms-client-principal-id` only under `OMNI_AUTH_MODE==='easyauth'`, else `DEFAULT_TENANT='local'`.
- Per-tenant managers: `createTenant(tenantId)` at `managers.ts:223`; `PgSettingsStore(pool, tenantId, replicaId)` (full-document write-through of the whole blob on every `set`).
- `sendToTenant` broadcasts to every session whose `session.tenantId` matches (`ws-handler.ts:147`). **`persistentSessions` key is `${tenantId}::${sessionId}` — the `\0` in the ws-handler type-comment is stale; code uses `::`.**
- Multi-replica: `createPgListener` on `omni_change`; triggers `pg_notify {t, o}` (v3) and page-content `{t, p}` (v5).
- `config-materializer.ts` `materializeAgentConfig`/`collectSecretEnv` rewrite secrets to `${OMNI_SECRET_*}` refs; per-tenant spawn env built in `getExtraEnv` (`managers.ts:244`). `resolveGitToken: (id)=>secretStore.getGitToken(id)` (`managers.ts:240`); `secretStore = new ServerSecretStore()` single shared instance (`managers.ts:209`).
- **`ServerSecretStore` durability caveat:** AES file keyed by `OMNI_SECRET_KEY` or a persisted random `secret.key`. On Azure App Service the local disk is not durable across re-deploys/scale → effectively ephemeral unless `OMNI_SECRET_KEY` is provisioned. Real gap.
- Tickets have **no assignee** today (project-only).
- `omni_app` role exists only for local docker (`docker/postgres-init.sql`); Azure leaves it a manual README step.
- Only `x-ms-client-principal-id` is parsed today; `x-ms-client-principal-name` + base64 `x-ms-client-principal` claims blob are available at the edge but unused → source for the `users` table.

**Keystone fact:** today tenant == principal, so `user_settings` and the 8 project tables are co-keyed by the same id. Splitting tenant→team keeps project tables keyed by `team_id` (relabel, no row move) but `user_settings` must be re-keyed principal→(principal, team) and bifurcated into `team_settings`(team) + `user_settings`(principal). That bifurcation is the migration's hard part.

## 1. Decisions (resolved)

### 1.1 Control-plane scoping

`users`/`teams`/`team_members`/`invitations` are NOT under `app.current_tenant`. Introduce a second GUC **`app.current_principal`** set per-tx; principal-scoped RLS on these tables. Membership lookups go through a **`SECURITY DEFINER` function `omni_team_ids(principal)`** to avoid RLS self-recursion on `team_members`. Read-isolation via RLS; membership/role **writes** additionally app-level capability-checked server-side. `omni_app` (NOBYPASSRLS) becomes mandatory.

### 1.2 Roles + capabilities

`role ∈ {owner, admin, member}`. member = read/write project data, own user overlay, read merged team settings (secrets masked). admin = + write team_settings (T-layer), rotate team secrets, invite/remove/role member↔admin. owner (exactly one) = + transfer ownership, delete team. Any member may assign tickets.

### 1.3 Bootstrap

**Auto-create a personal team** on first sign-in (principal with no memberships): create `users` row (from EasyAuth claims), `teams` row `kind='personal'`, `team_members` owner row. That team's id is the default active team. Invitations are additive (accepting adds a membership; never blocks getting your personal team).

### 1.4 Existing-data migration (zero loss, no re-onboarding)

For each existing principal (`tenant_id != 'local'`): create user + **team with `id = principal`** (reuse the principal id as the personal team id → **no project-data row is rewritten**, since every row already has `tenant_id = principal`) + owner membership. Bifurcate the existing `user_settings.data` blob: T-keys → `team_settings(team_id=principal)`; G-keys → `user_settings_v2(principal)` top level; P-keys → nested under `data->'byTeam'->principal`. Because it's a migrated solo user, the whole prior config becomes the team base with an empty user overlay → **effective merged config is byte-identical to today**. Always create a `'local'` user/team/membership idempotently so non-easyauth keeps working. Retain old `user_settings` (drop in a later release).

### 1.5 Membership resolution + session wiring

Principal = identity (EasyAuth id or `'local'`). Client sends `activeTeamId` on `/ws` (persisted in `localStorage`, defaults to personal team). On connect: bootstrap user → resolve requested team → **verify `(team, principal)` membership, else close `4403`** → session carries `principalId` (identity) + `teamId` (data scope). `createTenant` re-keyed by `teamId`; user-scoped reads/secrets keyed by connecting principal. `HandlerContext` + `PersistentSession` gain `principalId`; session key → **`${teamId}::${principalId}::${sessionId}`**. Runtime-token claims → `{teamId, principalId, sessionId}`.

**Fan-out gap (must fix with the re-keying, not after):** `store:changed` carries the full `StoreData` incl. U-only P-keys (`codeTabs`, `activeTicketId`, …). Broadcasting one user's tabs team-wide is a leak + bug. Fix: project/team keys via `sendToTenant(teamId, …)`; **user-scoped keys via new `sendToPrincipalInTeam(teamId, principalId, …)`**. Mutation handlers route by key class.

### 1.6 Authorization (server-side only)

`requireRole(ctx, teamId, min)` in new `src/server/authz.ts` gates all T-layer writes + control-plane mutations. U-layer writes never gated. Renderer only hides/disables admin UI by `team:get-my-role`. **Team secrets masked**: merged `settings:get-*` replaces team-origin secret fields with sentinel `"__OMNI_TEAM_SECRET__"`; on save, sentinel = preserve stored value (never overwrite); rotation is an explicit admin action.

## 2. Data model (PG migrations v6–v9)

- **v6** — `tickets.assignee TEXT` (Commit 0, precursor).
- **v7** — control-plane tables (`users`, `teams` with `kind` + `id`=principal for personal, `team_members` with role check, `invitations`), `omni_team_ids()` SECURITY DEFINER fn, principal-scoped RLS.
- **v8** — `team_settings(team_id PK)` (team-RLS via `app.current_tenant`) + `user_settings_v2(principal_id PK)` (principal-RLS via `app.current_principal`). `user_settings_v2` is principal-scoped (a user reads their overlay across all teams) with P-keys under `data->'byTeam'->team_id`.
- **v9** — `user_secrets(principal_id, cred_id)` + `team_secrets(team_id, ref_name)` for the Postgres-backed secret store. Backfill (the 1.4 algorithm) guarded by `_teams_backfill_done`, idempotent, pure-SQL JSONB projection.

Each new settings/secret table needs its own notify trigger emitting `{t: team_id}` (they lack the `tenant_id` column the v3 trigger reads).

## 3. Settings split

Replace `PgSettingsStore(pool, teamId)` with a **`CompositeSettingsStore`** (same `get/set/delete/clear/store/onDidAnyChange` surface) wrapping `TeamSettingsStore(pool, teamId)` (→ `team_settings`) + `UserSettingsStore(pool, principalId)` (→ `user_settings_v2`, with `byTeam[teamId]` accessor). Routing by static key-class map `src/shared/settings-layers.ts` (T/G/P/D/infra, from the doc). `get(T-key)` returns the **merged** value; `set` of team base vs user overlay distinguished by **separate IPC channels** (`settings:set-*` = my overlay; new `team-settings:set-*` = team base, admin-gated). `store` getter returns fully merged `StoreData` for `(principal, team)` with team secrets masked. Renderer `$store` shape unchanged. Local/SQLite keeps the single `ServerStore` (`: store` branch untouched).

## 4. Per-launching-user config merge

New `src/main/config-merge.ts` pure fns: `mergeModelsConfig` (providers union, U shadow; `default = user ?? team`), `mergeMcpServers` (union, U shadow, minus user `mcpTombstones`), `mergeEnvVars` (overlay U over T, re-apply T for `envLockedKeys`), `mergeNetwork` (deployment-floor ∩ team), collection merges (skills/extensions/customApps; `enabledExtensions` U-`false` wins). `getExtraEnv` resolves the **launching principal** (threaded via spawn options from the session ctx), merges layers, and `collectSecretEnv` is made **origin-aware** (run secret extraction separately on team vs user config, tag each `${OMNI_SECRET_*}` ref's origin, resolve from the right store). Materialized config dir → `tenants/<teamId>/users/<principalId>`. `resolveGitToken` → principal-scoped.

## 5. Secret storage

Move secrets to Postgres behind the existing `SecretStore` interface. `user_secrets` (principal-RLS, follows user across teams — git/github) + `team_secrets` (team-RLS, model/MCP keys, masked + admin-rotated). New `PgSecretStore` (cloud); file `ServerSecretStore` stays for local/Electron. **`OMNI_SECRET_KEY` becomes required in cloud** (fail boot if unset under easyauth). Closes the ephemeral-disk gap. `managers.ts:209` → `pgPool ? new PgSecretStore(...) : new ServerSecretStore()`.

## 6. IPC surface

`team:list`, `team:get-my-role`, `team:create`, `team:invite`/`accept-invite`/`revoke-invite`/`remove-member`/`set-role`, `team:switch` (validate membership → renderer reconnects WS with new `activeTeamId`). Split settings: `settings:set-*` (overlay, ungated) vs `team-settings:get-*`/`set-*` (base, admin-gated); `settings:get-*` returns merged+masked. `team-secrets:rotate` (admin). All gated channels call `requireRole`.

## 7. Ticket assignee (Commit 0 precursor)

`tickets.assignee TEXT` (PG + SQLite migrations), `Ticket.assignee?`, bridge `rowToTicket`/`ticketToRow`, repo insert/update SQL, renderer assignee picker (choices from `team:list`), "my active tickets" = non-terminal tickets where `assignee === myPrincipalId` (the only consumer of the now-P-scoped `wipLimit`). Harmless in single-user mode (always self/unset).

## 8. omni_app role + bicep automation

**Automate now.** `deploy.sh` post-provision step creates `omni_app` NOSUPERUSER NOBYPASSRLS, `ALTER SCHEMA public OWNER TO omni_app` (so migrations run as omni_app → FORCE RLS applies during migration), and the app's `OMNI_DATABASE_URL` points at `omni_app` (admin used only for role creation). `main.bicep` parameterizes `omniAppPassword`. **Boot guard:** in cloud, assert connected role is not superuser and not `rolbypassrls` → refuse to start otherwise (fail-closed). Update README/DEPLOY to "automated."

## 9. Commit sequence

- **0 — Ticket assignee** (independent precursor; PG v6 + SQLite migration; bridge; repos; UI).
- **1 — omni_app automation + RLS boot guard** (infra + boot assertion; hardens existing single-tenant deploy; no data change).
- **2 — Control-plane tables + composite settings/secret tables + backfill** (PG v7/v8/v9; `pg/settings.ts` team+user fns; new `control-plane.ts`, `pg-secret-store.ts`; migration tests incl. byte-equal effective-config assertion).
- **3 — Settings split + merge module + masking** (`settings-layers.ts`, `composite-settings-store.ts`, `config-merge.ts`, `config-materializer` origin-aware; `managers.ts` composite store + per-principal merge + per-(team,principal) dir + PgSecretStore; server-side masking).
- **4 — Membership resolution + session wiring + fan-out split** (`index.ts` bootstrap/verify/activeTeam; `ws-handler.ts` principalId + key + `sendToPrincipalInTeam`; `managers.ts` team-keyed tenants + routed broadcasts; runtime-token + mcp-http claims; `authz.ts`).
- **5 — Control-plane IPC + team UI + admin gating** (`team-handlers.ts`; IPC types incl. `mcpTombstones`/`envLockedKeys`; renderer `Teams` feature + settings tabs + masking + role-gated UI; transport sends `activeTeamId`/reconnect; Electron no-op equivalents).
- **6 — Cleanup** (later release: drop legacy `user_settings` after bake).

## 10. Risks

- **Cross-team leak via superuser** — highest severity; gate rollout on Commit 1 (omni_app + boot guard).
- **Migration data loss** — new tables populated by copy, source retained, guarded; test merged effective `StoreData` byte-equals pre-migration blob.
- **personal-team-id == principal-id invariant** — shared teams get UUIDs; personal teams reuse principal id (EasyAuth GUID or `'local'`); uniqueness from `teams` PK.
- **`store:changed` user-key leak** — must land _with_ team re-keying (Commit 4), not after.
- **Secret masking round-trip** — server must preserve stored value when sentinel echoed back; test it.
- **RLS recursion on `team_members`** — `SECURITY DEFINER omni_team_ids()` in the same migration as the policy.
- **Multi-replica NOTIFY** — new settings/secret tables need dedicated notify triggers; listener re-hydrates both composite halves.
- **Tests** — new suites for control-plane, composite store, config-merge, authz, backfill; existing local/single-tenant tests stay green (SQLite branch untouched). PG tests follow the existing `pg-repo.test.ts` pattern (need a Postgres).
