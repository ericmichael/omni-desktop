# Cloud state invariant: no durable state on the container filesystem

## The principle

In the cloud deployment (Path B — the launcher *server* running as a Web App for
Containers; see `infra/main.bicep` and the root `Dockerfile`), the "host
filesystem" is the App Service container's local disk. That disk is:

- **Ephemeral** — wiped on every restart, redeploy, and scale event. Nothing
  written there survives a new revision.
- **Per-replica** — not shared between instances when the plan scales out. The
  Bicep already assumes multiple replicas (hence the "must be stable across
  replicas" `runtimeTokenSecret`), so a file written on one instance is invisible
  to the next request that lands on another.
- **Not tenant-scoped** — there is one disk per container, shared by every
  tenant the replica serves.

So the invariant we design against is:

> **Durable or tenant-scoped state lives in Postgres (settings + project data) or
> Azure Files (workspaces) — never the container disk. The container disk holds
> only artifacts that are regenerated at boot from those durable inputs.**

By this definition, depending on the host filesystem is acceptable *only* for
derived scratch that is rebuilt deterministically on startup. It is **not**
acceptable for anything a user edits and expects to persist, or anything that
must differ per tenant.

## What already honors the invariant

| Concern | Durable home in cloud | Code |
|---|---|---|
| Settings (per-tenant) | Postgres `user_settings` JSONB row (RLS-isolated) | `PgSettingsStore` (`src/server/managers.ts:217`) |
| Project data (projects/tickets/milestones/pages/inbox/tasks) | Postgres | `PgProjectsRepo` (`src/server/managers.ts:81`) |
| Project workspaces | Azure Files share, mounted at `/workspace` | `aci-profile.ts` `file_share` block; `infra/main.bicep` storage + share |
| Agent runtime (omni CLI) | Baked into the image; no runtime install | `OMNI_CLI_PATH` (`Dockerfile`; `src/main/omni-install-manager.ts:631`) |
| `aci.yml` / `aci-desktop.yml` sandbox profile | Written to the container disk, **but fully regenerated from env vars on every boot** | `writeAciProfile` ← `buildAciProfile` (`src/main/aci-profile.ts:111`), called in `src/server/managers.ts:167` |

The `aci.yml` write is the canonical example of an *acceptable* host-fs
dependency: it is a pure function of the `OMNI_AZURE_*` / `AZURE_STORAGE_*`
environment variables (which come from the Bicep outputs), so losing it on
restart costs nothing — it is rewritten before the first request.

## Formerly-violating configs, now resolved (v23)

The four Settings configs that used to be written straight to the **shared,
ephemeral** container config dir (`models.json` / `mcp.json` / `network.json` /
`.env`) are now store-backed and honor the invariant:

| Setting (Settings tab) | Store key | How secrets stay off disk |
|---|---|---|
| Models | `modelsConfig` | per-tenant `user_settings` (Postgres); `api_key` rewritten to `${OMNI_SECRET_*}` refs on disk |
| MCP Servers | `mcpConfig` | per-tenant `user_settings`; `env`/`headers` values rewritten to refs |
| Network | `networkConfig` | per-tenant `user_settings`; non-secret, materialized verbatim |
| Environment | `envVars` | per-tenant `user_settings`; injected straight into the agent env — **no `.env` file written in cloud** |

How it works (see `src/main/config-materializer.ts` and `src/server/managers.ts`):

1. **Source of truth is Postgres** — the configs are keys in the per-tenant,
   RLS-isolated `user_settings` row, edited via typed `settings:*` IPC channels
   (`src/shared/ipc-handlers.ts`) instead of the path-based `config:*` file I/O.
2. **The on-disk files are a derived, secret-free artifact.** At agent launch
   (and on every write / cross-replica `NOTIFY` refresh) the launcher
   materializes per-tenant `models.json`/`mcp.json`/`network.json` into
   `<configDir>/.config/omni_code`, rewriting every secret to a stable
   `${OMNI_SECRET_<hash>}` reference. The real values are injected into the agent
   process env via `getExtraEnv`, and `XDG_CONFIG_HOME` points the child
   `omni serve` at that dir. The agent's loaders (`_expand_env_vars`) resolve the
   refs — so a provider key or MCP secret never lands on the container disk.

This closes all three problems for these configs: **durable** (Postgres),
**replica-coherent** (the `NOTIFY` handler re-materializes), and
**tenant-isolated** (RLS + per-tenant dirs). Desktop keeps writing plaintext
files (single user) — the file is simply a derived copy of the store now.

A one-time, idempotent migration (`src/main/config-files-migration.ts`) imports
any pre-existing on-disk files into the store on desktop / local single-tenant
server; cloud tenants start empty so a shared container file is never imported.

Several Settings controls that are no-ops in hosted mode are now hidden there
(Workspace directory, Reinstall runtime, "omni in PATH", Opt-in to Launcher
Prereleases, local-file Skills install, and the `.env` path label) — gated on
`isElectron` (`src/renderer/services/ipc.ts`).

## Remaining softer case: skills

Skills use a **per-tenant** config dir (`src/server/managers.ts`), so they are
tenant-isolated — but the files still live on the ephemeral container disk, so
installed skills do not survive a redeploy and do not replicate across instances.
Moving skills to a durable per-tenant store is the next increment.
