# Plugins Rail Tab — Unified Explore & Manage Surface

## Summary

Add a top-level **Plugins** rail tab that unifies the four extensibility
surfaces currently scattered across Settings — Skills (marketplace bundles),
Apps (custom web apps), Extensions (content modules), and MCP Servers — into
one ChatGPT-style page: a searchable Explore gallery fed by curated
marketplaces, plus Installed management (toggles, updates, uninstall,
configure). The marketplace manifest grows a `connectors[]` array so MCP
servers become one-click installable presets. The four Settings tabs are
**deleted in the same change** (no transitional duplication, per the
no-compat convention).

## Vocabulary

- **Plugin** — umbrella term for anything on this page. Four kinds:
  - **Connector** — an MCP server entry in `McpConfig.mcpServers`
  - **Skill** — a `SkillEntry`; marketplace bundles (`MarketplacePlugin`)
    install/update sets of skills
  - **App** — a `CustomAppEntry` web app (deck column)
  - **Extension** — an `ExtensionDescriptor` (built-in registry, e.g. Marimo)

---

## 1. Shared types & data model

### 1.1 `LayoutMode` gains `'plugins'`

Three places, in lockstep (all verified locations):

- `src/shared/types.ts:52` — add `'plugins'` to the `LayoutMode` union.
- Store schema `layoutMode.enum` (`src/shared/types.ts` ~line 613) — add
  `'plugins'`. (The store is created with `clearInvalidConfig: true`; a value
  missing from the enum wipes the config — same hazard as the documented
  theme-enum incident.)
- `VALID_LAYOUT_MODES` in `src/lib/store-init.ts:10` — add `'plugins'`,
  otherwise `migrateLayoutMode` resets anyone persisted on the new tab back
  to `'chat'` on next boot.

### 1.2 Marketplace manifest: `connectors[]`

In `src/shared/types.ts`, next to `MarketplacePlugin` / `MarketplaceApp`:

```ts
/**
 * One entry in a marketplace.json connectors[] array — a pre-configured MCP
 * server the user can install with one click. `server` is the exact entry
 * merged into McpConfig.mcpServers under key `id`.
 */
export type MarketplaceConnector = {
  /** Stable id; becomes the McpConfig.mcpServers key. */
  id: string;
  label: string;
  description: string;
  /** Fluent icon name resolved via AppIcon's ICON_MAP; optional. */
  icon?: string;
  server: McpServerEntry;
};
```

`MarketplaceManifest` gains `connectors?: MarketplaceConnector[]`.
`fetchMarketplace` (`src/main/skills-marketplace.ts`) parses the manifest via
`JSON.parse` and returns it whole, so no backend change is needed for the
field to flow through — but `readManifest` must **not** reject manifests
lacking `connectors` (it's optional, same as `apps`).

Env-var placeholders in `server.env` (e.g. an API key the user must supply)
ship as empty-string values; the configure dialog (§3.4) is where the user
fills them in after install. No templating/prompt flow in v1.

### 1.3 No other store/IPC changes

`customApps`, `installedBundles`, `skills:*`, `extension:*`, and
`settings:get/set-mcp-config` all exist and are shell-agnostic (registered in
`src/shared/ipc-handlers.ts` / both `main/index.ts` and `server/managers.ts`).
Connector install/uninstall is a renderer-side read-modify-write of
`McpConfig` through the existing `agentConfigApi.getMcp()/setMcp()` — no new
IPC channels.

---

## 2. Navigation

### 2.1 Rail entry (`src/renderer/app/Sidebar.tsx`)

Add to `ALL_TABS` between `routines` and `gallery`:

```tsx
{
  value: 'plugins',
  label: 'Plugins',
  icon: <PuzzlePiece24Regular />,
  iconActive: <PuzzlePiece24Filled />,
  alwaysVisible: true,
  desktopOnly: true,
},
```

New `desktopOnly?: boolean` flag on the tab def. Implementation: a
`desktopOnlyItem` makeStyles class — the inverse of the existing
`mobileOnlyItem` (`display: 'none'`, visible at `@media (min-width: 640px)`) —
applied in `renderTab` when `tab.desktopOnly`. The keyboard-nav handler
already filters to visible buttons via `offsetParent !== null`, so hidden
tabs stay out of arrow-key order with no further work.

Rationale: the mobile bottom bar already carries six tabs; per the
attention-centric IA doc, mobile stays lean. Mobile users reach Plugins via
§2.3.

### 2.2 Panel mount (`src/renderer/app/MainContent.tsx`)

Add `{ key: 'plugins', Component: PluginsView }` to the `panels` array
(lazy-mount-never-unmount applies automatically).

### 2.3 Mobile entry point (SettingsPage grouped list)

In `SettingsPage.tsx`'s **mobile grouped list only** (the
`activeTab === null` block), append one `ListItem` at the end of the
Developer group: icon `PuzzlePiece20Regular`, label "Plugins", `onClick` →
`persistedStoreApi.setKey('layoutMode', 'plugins')`. It is _not_ added to
`TAB_GROUPS` (so the desktop Settings nav — where the rail already has
Plugins — doesn't duplicate it).

### 2.4 Deep links

New `src/renderer/features/Plugins/plugins-nav.ts`, mirroring
`settings-nav.ts`'s one-shot-atom pattern:

```ts
export const $pluginsInitialFilter = atom<PluginKind | 'all' | null>(null);
export const openPlugins = (filter: PluginKind | 'all' = 'all') => {
  $pluginsInitialFilter.set(filter);
  void persistedStoreApi.setKey('layoutMode', 'plugins');
};
```

The only existing settings deep link (`SessionStatusBanner` →
`openSettingsTab('AI')`) targets a surviving tab and is untouched. No caller
targets the four removed tabs (verified by grep).

---

## 3. The Plugins feature (`src/renderer/features/Plugins/`)

New feature module following the feature-owns-components-plus-state
convention.

### 3.1 Files

| File                        | Responsibility                                                   |
| --------------------------- | ---------------------------------------------------------------- |
| `PluginsView.tsx`           | Root page: PageHeader, search, filter chips, sections            |
| `plugins-nav.ts`            | `openPlugins()` + one-shot filter atom (§2.4)                    |
| `state.ts`                  | Data-loading atoms/hooks (installed lists, manifests, updates)   |
| `plugin-cards.ts`           | **Pure** unification/filter logic (no React/IPC) — see §3.2      |
| `plugin-cards.test.ts`      | Unit tests for §3.2                                              |
| `InstalledSection.tsx`      | Installed cards with toggle/update/uninstall/configure           |
| `ExploreSection.tsx`        | Per-marketplace featured sections + install buttons              |
| `ConnectorConfigDialog.tsx` | Per-server MCP form (moved from the MCP tab)                     |
| `AppFormDialog.tsx`         | Custom-app add form (moved from the Apps tab)                    |
| `MarketplaceDialog.tsx`     | Arbitrary `owner/repo` browser (moved from Skills tab, extended) |

### 3.2 Unified card model (`plugin-cards.ts`, pure)

```ts
export type PluginKind = 'connector' | 'skill' | 'app' | 'extension';

export type InstalledPlugin =
  | { kind: 'connector'; id: string; server: McpServerEntry }
  | { kind: 'skill'; skill: SkillEntry; update?: BundleUpdateInfo }
  | { kind: 'app'; app: CustomAppEntry }
  | { kind: 'extension'; ext: ExtensionDescriptor };

export type ExplorePlugin =
  | { kind: 'connector'; repo: string; connector: MarketplaceConnector; installed: boolean }
  | { kind: 'skill'; repo: string; plugin: MarketplacePlugin; installed: boolean; update?: BundleUpdateInfo }
  | { kind: 'app'; repo: string; app: MarketplaceApp; installed: boolean };
```

Pure functions (each unit-tested):

- `buildInstalledPlugins(mcp, skills, updates, customApps, extensions): InstalledPlugin[]`
- `buildExplorePlugins(manifestsByRepo, installedState): ExplorePlugin[]`
  — installed detection: connector → `id in mcpConfig.mcpServers`; skill
  bundle → existing `isBundleInstalled` logic (moves here from the Skills
  tab); app → URL match (moves here from the Apps tab).
- `filterPlugins<T>(items, kind: PluginKind | 'all', query: string): T[]`
  — case-insensitive substring match on name/label + description; kebab-case
  skill-bundle names matched both raw and title-cased (`formatPluginName`
  moves here).

### 3.3 Page layout (`PluginsView.tsx`)

Single scrollable page (max-width content column, like SettingsPage's
`contentInner` but wider — 960px — for the two-column card grid):

1. **`PageHeader`** (DS): title "Plugins", subtitle "Extend Omni with
   connectors, skills, apps, and extensions.", trailing search `Input`.
2. **Filter chip row** — All · Connectors · Skills · Apps · Extensions
   (DS `SegmentedControl`). Consumes `$pluginsInitialFilter` one-shot on
   mount-or-change, same pattern as `$settingsInitialTab` in SettingsPage.
3. **Installed** section — rendered when non-empty after filtering. Cards per
   kind (§3.4).
4. **Featured** sections — one per entry in `FEATURED_MARKETPLACES`
   (constant moves here from the Skills tab: Omni Official =
   `ericmichael/omni-plugins-official`, Anthropic = `anthropics/skills`).
   Each renders the manifest's `connectors[]`, `plugins[]`, and `apps[]` as a
   responsive card grid (ChatGPT-style two columns ≥640px, one below),
   filtered by chip + search. Fetch failure hides the section (current
   behavior); loading shows `Spinner` cards.
5. **Footer actions** row: "Add custom app" (opens `AppFormDialog`),
   "Add custom MCP server" (name prompt inline → opens
   `ConnectorConfigDialog` on a new empty entry), "Install skill from file"
   (Electron only, existing `util:select-file` flow), "Browse a marketplace…"
   (opens `MarketplaceDialog`).

Search + chip filter apply to sections 3–4 simultaneously; a filter that
empties a section hides that section's header.

### 3.4 Card behaviors

**Explore cards** (icon · name · one-line description · action button):

- _Connector_: Install → `getMcp()`, merge `{[id]: server}` into
  `mcpServers`, `setMcp()`; button flips to "Added". If the id already
  exists with a **different** config, show "Added" (never overwrite an
  edited server silently).
- _Skill bundle_: Install / Update / Installed states — port the exact
  state machine from `FeaturedMarketplaceSection` (spinner, one-at-a-time
  `installingPlugin` gating, `formatUpdateSummary` badge).
- _App_: Add → existing `installMarketplaceApp` logic (URL-dedup, order =
  max+10).

**Installed cards** (grouped flat, each showing its kind as a small chip):

- _Connector_: summary line (`type · command/url`, as the MCP accordion
  header today), **Configure** button → `ConnectorConfigDialog`, delete
  button (removes key from `McpConfig`, with `ConfirmDialog`). No
  enable/disable toggle — `McpConfig` has no disabled state and inventing
  one is out of scope.
- _Skill_: toggle (`skills:set-enabled`), uninstall (`ConfirmDialog`,
  existing copy), source line (`formatSource`), bundle update badge when its
  bundle has `update-available`.
- _App_: icon/label/url, "In dock" toggle (columnScoped), remove — ported
  from `AppCard`.
- _Extension_: toggle (`extension:set-enabled`), content-type chips — ported
  from `ExtensionCard`. Extensions never appear in Explore (built-in
  registry only, until `~/.omni/extensions/` lands).

### 3.5 `ConnectorConfigDialog`

The per-server form from `McpServerRow` (type select, command/args or URL,
headers, env key-value editor — `KeyValueSection`/`KvRow` move wholesale)
inside an `AnimatedDialog` with Save/Cancel. Save = read-modify-write of the
whole `McpConfig` (replace the one entry, `setMcp`). Renaming a server is
out of scope (id is fixed once created; matches today's accordion, where the
name is the accordion key).

### 3.6 `MarketplaceDialog`

Ported from the Skills tab, extended to render all three manifest arrays
(`connectors[]`, `plugins[]`, `apps[]`) with the same install actions as
Explore cards. Default repo stays `anthropics/skills` with auto-load.

### 3.7 Data loading (`state.ts`)

On first mount (and after any mutation): `skills:list`,
`skills:check-bundle-updates`, `extension:list-descriptors`,
`agentConfigApi.getMcp()`, plus one `skills:fetch-marketplace` per featured
repo (parallel, independent failure). `customApps` comes reactively from
`persistedStoreApi.$atom`. A single `refresh()` used as the post-mutation
callback, matching the Skills tab's `load()` idiom. No polling.

---

## 4. Deletions (same commit — no transitional duplication)

- `SettingsModalSkillsTab.tsx`, `SettingsModalAppsTab.tsx`,
  `SettingsModalExtensionsTab.tsx`, `SettingsModalMcpTab.tsx` — deleted.
  (Verified: no importer besides `SettingsPage.tsx`.) Reusable pieces move
  per §3 rather than being re-exported.
- `SettingsPage.tsx`: remove the four values from the `SettingsTab` union,
  their `TAB_GROUPS` entries (Personal loses Apps + Skills; Developer loses
  MCP Servers + Extensions), imports, and content-switch lines. Developer
  band becomes Workspace · Environment · Git · Network.
- Icons that become unused in SettingsPage (`Apps20Regular`,
  `Lightbulb20Regular`, `PlugConnected20Regular`, `PuzzlePiece20Regular`)
  are pruned from its import — except `PuzzlePiece20Regular`, reused by the
  §2.3 mobile row. knip will fail lint on anything missed.

Everything else in Settings (AI, Network, Environment, Git, etc.) is
untouched.

## 5. Marketplace repo follow-up (separate repo, not this codebase)

`ericmichael/omni-plugins-official`'s `marketplace.json` gains a
`connectors[]` array (e.g. GitHub, Teams/Graph presets). Not part of this
plan's diff; the launcher handles manifests with or without the field. For
local testing, point `MarketplaceDialog` at any repo/branch with a
`connectors[]` array (`owner/repo@ref` is already supported by
`parseRepoSpec`).

## 6. Test plan

- **`src/renderer/features/Plugins/plugin-cards.test.ts`** (new, pure —
  no jsdom dependencies beyond vitest defaults):
  - `buildInstalledPlugins` merges all four sources; skill update info
    attaches by bundle key; empty inputs → empty list.
  - `buildExplorePlugins` installed-detection: connector id present /
    absent in `mcpServers`; bundle installed via marketplace source match;
    app URL match.
  - `filterPlugins`: kind filter, case-insensitive query on
    name+description, title-cased bundle-name matching, `'all'` + empty
    query passthrough.
- **`src/lib/store-init.test.ts`**: `migrateLayoutMode('plugins')` returns
  `null` (already valid — regression against the reset-to-chat trap).
- Type-level: the `LayoutMode`/schema-enum/`VALID_LAYOUT_MODES` triple has
  no parity test today; the store-init test above covers the one that
  silently bites.
- Manual acceptance (types/lint carry the rest, per project convention):
  rail tab appears on desktop and not on the mobile bar; mobile Settings
  row navigates to Plugins; installing a connector writes `mcpConfig`;
  the four Settings tabs are gone; `npm run lint` passes (knip + dpdm
  clean).

## 7. Execution order

1. Types + nav plumbing: §1.1, §1.2, rail entry, MainContent panel, empty
   `PluginsView` stub.
2. Feature build-out: pure `plugin-cards.ts` + tests, then state.ts, then
   sections/dialogs (porting the four tabs' logic).
3. Deletions + SettingsPage trim + mobile Settings row (§4, §2.3).
4. `npx vitest run src/renderer/features/Plugins/plugin-cards.test.ts
src/lib/store-init.test.ts` + `npm run lint`.

## 8. Assumptions (decided without further input)

- **Manifest field name `connectors[]`** (not `mcp[]`): user-facing kind is
  "Connector" (ChatGPT-familiar); `server` payload keeps the raw
  `McpServerEntry` shape so nothing is invented.
- **Desktop-only rail slot**, mobile via a Settings Developer-band row —
  keeps the mobile bar at six items per the attention-centric IA stance.
- **Single scrollable page with chip filters**, not sub-tabs: Installed
  above Featured. Discovery-first ordering (ChatGPT-style) loses to
  management here because updates/toggles are the recurring visit reason;
  first-run users see Featured immediately anyway since Installed hides
  when empty.
- **No MCP enable/disable toggle** and **no server rename** in v1 — both
  would require new config semantics; delete/re-add covers the need.
- **No rail badge** for available updates in v1 (minimal-scope).
- **Existing-id conflict on connector install shows "Added"** rather than
  overwrite or duplicate-key prompt.
- **Skills stay flat** in Installed (not grouped under bundles) — matches
  today's mental model; bundle identity shows in the source line and
  update badges.
