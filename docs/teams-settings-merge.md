# Teams: settings merge / precedence spec

Status: design (not yet implemented). Applies to the **Azure/cloud** deployment only — Electron and local-server modes stay single-user (see `docs/cloud-state-invariant.md` and the project memory). Scopes the question: when one deployment hosts many independent teams, where does each `StoreData` setting live, and how is the *effective* value computed for an agent run?

## Guiding principle

This is a **personal-first tool**. The default scope is **per-user**; "team" is the exception, reserved for genuinely shared *work artifacts* (the project/ticket data) and *optional shared base layers* of agent config. There is almost no "pure team-only setting" — the team owns the data, not the preferences.

## Layers (low → high precedence)

| Layer | Source | Writable by | Scope |
|---|---|---|---|
| **D — Deployment** | bicep / env (`OMNI_AZURE_*`, etc.) | operator only, immutable at runtime | whole deployment |
| **T — Team** | `team_settings` row (RLS-scoped) | team role ≥ admin | one team |
| **U — User** | `user_settings` row (per EasyAuth principal) | the user | global **(G)** or per-(user, team) **(P)** |

The RLS isolation boundary is the **team** (`app.current_tenant = team_id`). A user's session resolves: principal → team memberships → active team → set `app.current_tenant`. Identity (the principal) is separate from the data-scope key (the team).

## Merge operators

- **`D-only`** — value comes solely from D; T/U read-only.
- **`D-floor ⊕ T`** — D sets the maximally-permissive bound; T may only *further restrict*; effective = most-restrictive intersection. No U layer.
- **`T→U scalar`** — effective = `U ?? T ?? built-in default`.
- **`T ∪ U`** (collection keyed by id/name) — union; on key collision the **U entry shadows** the T entry; U may **tombstone** a T entry (hide it for that user).
- **`T ⊕ U`** (map overlay) — shallow key-merge, **U key wins**; T may mark keys **locked** (not user-overridable).
- **`U-identity`** — only U; resolved against the **principal running the agent**; never stored at T/D.
- **`U-only`** — only U; T/D irrelevant.
- **`infra`** — bookkeeping, per-store, not user-facing.

## Key-by-key

### Merged (team base + user overlay)

| Setting | Rule | Conflict / notes |
|---|---|---|
| `modelsConfig.providers` | `T ∪ U` | keyed by provider name; U shadows T. A member rides the team key or brings their own. |
| `modelsConfig.default` | `T→U scalar` | U's chosen default model, else team's. |
| `mcpConfig.mcpServers` | `T ∪ U` | keyed by server name; U shadows; U may tombstone a team server it doesn't want. |
| `envVars` | `T ⊕ U` | parse to map, U key wins; team may **lock** keys (e.g. a required base URL) so U can't override. |
| `skillSources` | `T ∪ U` | keyed by skill name; U's version shadows. |
| `installedBundles` | `T ∪ U` | keyed by `${repo}:${plugin}`; U shadows. |
| `enabledExtensions` | `T ∪ U` (per-id bool) | enabled if T or U enables; **U disable wins** for that user. |
| `customApps` | `T ∪ U` | keyed by app id; team dock + personal additions. |

### User-identity (never team)

| Setting | Rule | Notes |
|---|---|---|
| `gitCredentials` | `U-identity` | resolved against the launching user; pushes carry *their* identity, not a managed team bot. Team owns *which* repos via project `sources`, not the creds. |
| `githubAccount` | `U-identity` | per-user OAuth link. |

### User-only

| Setting | Rule | Scope | Notes |
|---|---|---|---|
| `theme`, `glassTone`, `codeDeckBackground` | `U-only` | G | appearance follows me across teams. |
| `layoutMode`, `codeLayoutMode` | `U-only` | G | |
| `audioSettings` | `U-only` | G | hardware. |
| `previewFeatures` | `U-only` | G | personal opt-in; D may hard-disable preview. |
| `weeklyReviewDay` | `U-only` | G | my review cadence (personal GTD-style review). |
| `lastWeeklyReviewAt` | `U-only` | P | tracks my review *within this team's work*. |
| `wipLimit` | `U-only` | P | my cognitive limit on my active tickets — **depends on a ticket-assignee concept** (see Guards). |
| `codeTabs`, `activeCodeTabId`, `activeTicketId` | `U-only` | P | my open columns / focus, against this team's projects. |
| `chatSessionId`, `chatProfileName`, `chatContainerId` | `U-only` | P | my chat's session + sandbox binding, per team. |
| `browserTabsets` | `U-only` | P | keyed by per-team `codeTabId`. |
| `browserProfiles`, `browserHistory`, `browserBookmarks` | `U-only` | G | personal browsing. |
| `onboardingComplete` | `U-only` | P | largely **derived** (auto-true if effective `modelsConfig` has providers); stored only to remember a dismissed welcome. |
| `defaultProfileName` | `T→U scalar` | P | constrained to D's `availableSandboxProfiles`. |

### Deployment-only / floor

| Setting | Rule | Notes |
|---|---|---|
| `availableSandboxProfiles`, sandbox CPU/mem | `D-only` | `OMNI_AZURE_*`-forced. |
| `platform` (enterprise creds) | `D-only` | |
| `networkConfig` | `D-floor ⊕ T` | egress security boundary; team may tighten, **no user overlay**. |

### Infra / N-A in cloud

`schemaVersion`, `agentConfigMigratedFromFiles`, `pagesMigration` → `infra` (per-store). `workspaceDir`, `launcherWindowProps`, `appWindowProps`, `optInToLauncherPrereleases`, `localUserId` → **N/A in cloud** (desktop-only; identity comes from the EasyAuth principal).

## Materialization at agent launch (user **P**, team **T**)

The effective config the agent sees is computed **per launching user**, in this order (this is the change to `src/main/config-materializer.ts` / `collectSecretEnv`):

1. `models.json` ← `merge(T.modelsConfig, U.modelsConfig)`, providers unioned (U shadows), `default = U.default ?? T.default`.
2. `mcp.json` ← `union(T.mcpServers, U.mcpServers)` minus U tombstones.
3. agent env ← `overlay(parse(T.envVars), parse(U.envVars))` with T-locked keys winning.
4. `network.json` ← `intersect(D.floor, T.networkConfig)`.
5. skills / extensions / customApps ← `union(T, U)` with U shadow/tombstone.
6. **Secrets**: each `${OMNI_SECRET_*}` ref resolves from the **layer the entry originated** — a user-layer provider's key from P's secret store, a team-layer provider's key from the team store; `gitCredentials`/`githubAccount` always from **P**. Injected into P's sandbox env, never written to disk (existing ref machinery).
7. Files written to **P's per-(user, team) materialized config dir**; env injected into P's agent process.

## Write authority & guards

- **T-layer writes** (model providers, mcp/env base, network policy, extensions/skills base, repo source config) require team role ≥ **admin**.
- **Shared secret visibility**: team-layer model keys are *usable* by members but **masked** in the UI (show "configured", admins rotate, never echo the value).
- **`wipLimit` dependency**: a per-user limit on "my active tickets" needs **ticket assignment**. A ticket is **always team-owned** (its team is the RLS scope and never changes); `assignee` is an *additive, optional* pointer to a member that only drives the personal "my work" filters (WIP, weekly review). Default is **Unassigned**; **any team member** may (re)assign, and assigning never alters ownership or visibility.
- **RLS prerequisite**: real cross-team isolation requires the non-superuser `omni_app` Postgres role (the manual README step). With genuine multi-team data this stops being optional.

## Data-model consequences (for the follow-on implementation plan)

- Split today's single per-tenant `user_settings` JSONB into **two stores**: `team_settings` (keyed by `team_id`, admin-gated) and `user_settings` (keyed by `principal_id`, with per-(user, team) sub-documents for the **P**-scoped keys).
- `PgSettingsStore` splits into a team store and a user store; the launcher reads both and merges per the table above.
- New control-plane tables: `users` (principal + EasyAuth profile), `teams`, `team_members` (team_id, user_id, role), `invitations`.
- `resolveGitToken` becomes **user-scoped** (resolved against the session principal), not team-scoped.
- Existing `sendToTenant` fan-out already broadcasts to all sessions sharing a tenant → with tenant = team, team members get live updates for free.
