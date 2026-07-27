# Sandboxes tab

## Problem

Sandbox management is smeared across five surfaces with no home:

- Default profile picker — Settings → Workspace (`SettingsModalWorkspaceTab`)
- Per-project profile — `ProjectCreateDialog` / `ProjectSettings`
- Per-launch override — `TicketAutopilotLaunchDialog`
- Live in-sandbox services — the Code column's `EnvironmentDock`
- Machine registry (computer-as-sandbox) — Settings → Account (`MachinesCard`)

And several real concerns have **no** UI at all:

- Which containers are running, which session owns each, and cleanup
  (`docker-orphan-cleanup.ts` sweeps invisibly at startup)
- Substrate health: is Docker reachable? On Windows, is the WSL daemon's
  `docker` status `ok`/`missing`/`daemon-down` (`WslBackendStatus.docker`)?
- What profiles exist and what each actually is — users must hand-edit
  `~/.config/omni_code/sandbox/*.yml` to see or change one
- Snapshot/warm-reattach state (`snapshot-manager.ts`, `codeTabs[].containerId`)

A Sandboxes tab gives this a home. It is a management surface, not an
attention surface — expect no badges (attention-centric IA: badges are for
work that wants you; substrate health only badges on `error`).

## Decisions (settled)

1. **Tab id `'sandboxes'`**, added exactly the way `'plugins'` was
   (docs/plugins-tab-plan.md is the walked path): the `LayoutMode` union +
   store schema enum + `VALID_LAYOUT_MODES`/`migrateLayoutMode` triple, plus
   the app-history title map. Older builds that see a persisted `'sandboxes'`
   reset to the default tab via the existing migration — no compat shim.
2. **Master-detail like every other tab** (one-master-per-tab rule): the
   sidebar master list is three fixed nodes — **Health**, **Profiles**,
   **Running** — mapping to detail panes. Fixed nodes, not data-driven; the
   data lives in the detail panes.
3. **Reuse `ProfileSummary`** (`src/shared/types.ts:68`) — it was typed for
   exactly this and currently has zero consumers. Discovery fills it from
   disk; the existing name-string pickers keep working unchanged in v1 but
   read their option list from the new discovery channel so all surfaces
   agree (today they derive lists from `availableSandboxProfiles` +
   hardcoded built-ins in `getAvailableProfileNames`).
4. **Profiles are read-only in v1.** The detail pane shows the parsed
   summary (client type, image, services, run_as, confine) and the raw YAML,
   plus "Reveal in file manager" / copy-path for user overrides and a
   "Create override" action that copies a bundled profile into
   `<config>/sandbox/<name>.yml`. In-app YAML editing is v2 — the launcher
   has no code-editor primitive and hand-rolling one violates
   reuse-the-real-surface; revisit once an editor surface exists.
5. **Link management stays in Settings.** The RemoteBackendCard (cloud/WSL/
   server link) is about _where the backend runs_, not sandboxes. The
   Sandboxes → Health pane shows a read-only substrate summary with a
   "Manage in Settings" affordance — no duplicated link/unlink controls.
6. **MachinesCard moves into Sandboxes → Health.** Machines exist solely as
   computer-as-sandbox targets — this tab is their natural home. The
   `MachineIdentityChip` stays on the settings RemoteBackendCard (it is
   about this device's identity to the cloud, not about sandboxes).
7. **Container actions are conservative.** v1 actions: stop+remove a
   container, and "Sweep orphans now" (the existing cleanup logic, made
   visible). Removal refuses containers in the protected set
   (`getProtectedContainerIds`: live agent processes + `codeTabs[].containerId`
   warm-reattach claims) — the UI shows _why_ a container is protected
   (owning session/tab) instead of a disabled mystery button.
8. **Works in both shells.** Everything main-side lands where both Electron
   and server mode can reach it. Docker enumeration runs on the backend
   (which is where dockerd is, in every topology — local, WSL daemon,
   cloud). The WSL-specific health row renders only when the client is
   WSL-linked (`isWslLinked`); browser/server mode hides it.

## Phase 1 — Tab plumbing

Mechanical, per the plugins-tab precedent:

- `src/shared/types.ts:52` — `'sandboxes'` in `LayoutMode`; the store schema
  enum near `layoutMode`; keep the triple in sync (a type-level test exists
  from the plugins work — extend it).
- `migrateLayoutMode` / `VALID_LAYOUT_MODES` in `src/lib/` (find via the
  plugins commit) — accept `'sandboxes'`.
- App-history titles map — add "Sandboxes".
- `AppSidebar` — entry with a container/box icon (Fluent), positioned after
  Plugins. Badge: only when Health is in an `error` state (docker
  unreachable while sandboxed sessions exist, or WSL daemon `error`).
- `src/renderer/features/Sandboxes/` — new feature module: `state.ts`
  (nanostores atom bundle: `$sandboxProfiles`, `$sandboxContainers`,
  `$substrateStatus`, selected master node) + `SandboxesTabContent.tsx`
  shell with the three-node master list.

## Phase 2 — Main-side IPC

New channels in `src/shared/types.ts` (grep for existing ids first;
`sandbox:` namespace is unused today) and handlers registered where both
shells reach them (`src/shared/ipc-handlers.ts` if the implementation stays
Electron-free, else per-shell registration like `wsl:*`):

- `sandbox:list-profiles` → `ProfileSummary[]`. Implementation in a new
  `src/main/profile-catalog.ts` beside `profile-resolver.ts`: enumerate
  bundled `assets/profiles/*.yml` + user `<config>/sandbox/*.yml` (user
  override wins per resolver semantics), parse `client.type`, derive
  `label`, mark `builtin`. Include the implicit `host` profile (omni
  serve's bundled default — no file in the launcher). Extend
  `ProfileSummary` with what the detail pane needs: `path: string | null`,
  `origin: 'builtin' | 'user-override' | 'implicit'`, and a small parsed
  `details` bag (image, services list, run_as, confine) — extending the
  dead type is free.
- `sandbox:read-profile` (name) → `{ yaml: string } | null` — raw file for
  the read-only view (null for `host`).
- `sandbox:create-override` (name) → copies the resolved bundled YAML into
  `<config>/sandbox/<name>.yml` and returns the new path. Refuse if an
  override already exists.
- `sandbox:list-containers` → `SandboxContainerSummary[]`:
  `{ id, name, image, createdAt, state, ownerKind: 'process' | 'warm-reattach' | 'orphan',
ownerLabel: string | null }`. Implementation reuses
  `docker-orphan-cleanup.ts`'s exec plumbing (`docker ps -a
--filter label=com.omni.omni-code --format json`) and its
  protected-id sources to compute ownership: live `ProcessManager`
  processes → `ownerKind: 'process'` with the session/tab title;
  `codeTabs[].containerId` → `'warm-reattach'`; neither → `'orphan'`.
- `sandbox:remove-container` (id) → guards against protected ids (throw
  with the owner label), then `docker rm -f`.
- `sandbox:sweep-orphans` → runs the existing cleanup pass on demand,
  returns `{ removed: string[] }`.
- `sandbox:substrate-status` → `{ docker: 'ok' | 'missing' | 'daemon-down';
dockerVersion?: string }` — a `docker info`/`docker version` probe using
  the same env resolution the orphan cleaner uses (`shellEnvSync`). On a
  WSL-linked client this executes daemon-side (inside the distro) because
  the channel rides the normal transport — which is exactly right.

Wire into `src/server/managers.ts` too (`wireGlobalHandlers`) so server
mode serves the same channels — the exec-based implementation has no
Electron imports, so registration should be shared, not duplicated.

## Phase 3 — UI panes

`src/renderer/features/Sandboxes/`, Fluent primitives from `@/renderer/ds`:

- **HealthPane** — substrate rows: Docker (status + version, with the
  docker-missing guidance copy reused from RemoteBackendCard's mapping);
  when `isWslLinked`, the WSL daemon row fed by the existing `wsl:status`
  poll (state, distro, persistent). `MachinesCard` moves here (import
  relocation — the card is already self-contained). Read-only backend-link
  summary + "Manage in Settings" (opens the settings modal at the right
  tab via the existing settings-navigation mechanism).
- **ProfilesPane** — master list of `ProfileSummary` rows (name, client
  type chip, origin chip, "default" marker from `defaultProfileName`,
  usage: which projects reference it via `sandboxProfile` — available from
  the projects atom). Detail: parsed summary + raw YAML (read-only,
  monospace, `overflow-x: auto`) + Create-override / Reveal actions +
  "Set as default" (writes `defaultProfileName` via `persistedStoreApi`,
  same as the settings picker).
- **RunningPane** — container table (name, image, state, owner, age) with
  per-row Remove (confirm dialog; disabled-with-reason for protected rows)
  and a "Sweep orphans" toolbar action. Poll `sandbox:list-containers`
  every 5s while the pane is visible.
- Refactor the three existing profile pickers to source options from
  `$sandboxProfiles` (fallback to the current hardcoded list while the
  atom is empty) — no behavior change, one source of truth. The
  `availableSandboxProfiles` store override keeps working: discovery
  filters to it when set (cloud/ACI deployments still force `['aci']`).

## Phase 4 — Tests

- `profile-catalog.test.ts` — discovery matrix: bundled only, user
  override shadowing, implicit host entry, malformed YAML (skip + warn),
  `availableSandboxProfiles` filter.
- `docker-orphan-cleanup.test.ts` likely exists — extend for the
  list/ownership join and the protected-removal guard (injected exec fake).
- Type-level `LayoutMode` triple test — extend the plugins one.
- UI: no new colocated tests unless a pane grows pure helpers (ownership
  labeling is main-side already).

## Explicitly out of scope (v2+)

- In-app YAML editing (needs a real editor primitive first — Decision 4).
- Snapshot browser (list/delete warm-reattach snapshots) — add once
  `snapshot-manager` grows a list API; the Running pane's warm-reattach
  rows are the v1 nod to it.
- "Install docker-ce in this distro" bootstrap button on the Health pane —
  natural sibling of the in-app `wsl --install` work; needs the same
  real-Windows validation pass first.
- Image management (pull/prune the devbox image).
- Per-container shell/log attach (the Console tab already covers the
  common case through the session).
