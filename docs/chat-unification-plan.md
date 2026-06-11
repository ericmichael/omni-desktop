# Chat Unification — Chat as a Special Case of the Column Implementation

> Status: IMPLEMENTED (2026-06-11). Kept as the architectural record.
> Origin: UI/UX audit (AUDIT.md §1.1 "Three front doors to the same room") — the structural
> item from the gameplan. Decisions below were confirmed with Eric on 2026-06-11.

## Summary

The Chat tab and a Spaces deck column are the same thing — an agent session on a sandbox —
implemented twice. Main-process side they already converge (`ProcessManager` keys chat as
process id `'chat'` in the same map as code tabs); the duplication is the renderer wrapper
layer. This plan makes the Chat tab render a reserved, pinned member of `codeTabs` through
`CodeTabContent`, deletes the parallel chat implementation (~450 lines), and gives Chat the
full per-column mini-OS (dock with Code / Desktop / Browser / Terminal).

**Locked decisions (Eric, 2026-06-11):**
1. Chat gains the dock (full mini-OS). The floating "Omni's PC" VNC widget is deleted;
   the Desktop dock app replaces it.
2. The chat column does NOT appear in the Spaces deck for now — Chat-tab only. The deck
   filters the reserved record out; surfacing it later as a pinned column is a one-line
   change.

## Current State (what is duplicated)

| Concern | Chat implementation | Column implementation |
|---|---|---|
| Launch lifecycle | `use-chat-auto-launch.ts` | `use-code-auto-launch.ts` (both wrap shared `useAutoLaunch`) |
| Identity/persistence | store keys `chatSessionId`, `chatProfileName`, `chatContainerId` | `CodeTab` fields `sessionId`, `profileName`, `containerId` |
| Status | `$chatProcessStatus` (computed view) | `$codeTabStatuses[tabId]` (same source map) |
| Status polling | `agent-process.ts` polls `'chat'` on an interval | `Code/state.ts` polls each tab |
| Running view | `SandboxRunningView` (direct `OmniAgentsApp`) | `CodeRunningView` → `CodeWorkspaceLayout` |
| VNC | `FloatingWidget` overlay ("Omni's PC") | Desktop dock app |
| Switch scrim, sandbox labels/options, profile-change semantics, session-change semantics, containerId capture | duplicated verbatim in `Chat.tsx` | `CodeTabContent.tsx` |
| Snapshot GC protection | special case in `main/index.ts` (`chatSessionId`) | `codeTabs` loop in the same block |

Chat-specific behavior that must survive:
- **Per-conversation scratch workspace**: `useSessionWorkspaceDir(store.workspaceDir, sessionId)`
  gives each conversation an isolated `<workspaceDir>/Sessions/<sessionId>` dir; switching
  conversations changes the workspace, which `useAutoLaunch`'s reset effect already turns into
  a sandbox restart. (Columns keep one workspace across sessions; this stays a chat-mode rule.)
- **Conversations drawer**: Chat mounts `OmniAgentsApp` non-minimal (header + sessions drawer).
  Columns set `minimal=true`. Preserved via the minimal flag, not a chat fork.
- **Pre-launch shell**: `ChatShell` greeting + Launch button + `SandboxPicker`, shown only when
  `store.workspaceDir` is unset (first-run). Preserved as the chat-mode idle branch.
- **`surface: 'chat'` session variables** and voice persona variables.

## Key Changes

### 1. Data model — reserved chat tab in `codeTabs`

- New constant `CHAT_TAB_ID = 'chat'` in `src/shared/types.ts` (exported; value intentionally
  equals the existing process id and `CHAT_VOICE_SCOPE`, so process keying, voice scoping, and
  activity publishing unify with zero further changes).
- No new `CodeTab` field. Chat-ness is `tab.id === CHAT_TAB_ID`. The record is a normal
  `CodeTab` with `projectId: null` and no `ticketId`/`customAppId`.
- `isChatTab(tab)` helper exported next to the constant; all special-casing goes through it.

### 2. Store migration (v25 → v26, `project-migrations.ts`)

In the v26 step:
- If `codeTabs` lacks an entry with id `CHAT_TAB_ID`, prepend
  `{ id: CHAT_TAB_ID, projectId: null, sessionId: chatSessionId ?? uuidv4(), profileName:
  chatProfileName ?? defaultProfileName ?? 'host', profileNameExplicit: false,
  ...(chatContainerId ? { containerId: chatContainerId } : {}), createdAt: now }`.
- Delete store keys `chatSessionId`, `chatProfileName`, `chatContainerId`.
- Remove the three keys from `StoreData` and from the electron-store JSON schema in
  `shared/types.ts`. (Schema validation runs at store construction, before migration: the root
  schema does not set `additionalProperties: false`, so pre-v26 data with the old keys still
  loads. Verify this during implementation; if root-level unknown keys are rejected, keep the
  three schema entries with a "legacy, removed v26" comment instead.)
- Existing conversation, container reattach, and snapshot continuity all follow from carrying
  the three values into the record.

### 3. `CodeTabContent` — chat mode

`CodeTabContent` becomes the single session surface. Behavior keyed on `isChatTab(tab)`:

- **Workspace**: instead of the project-derived `workspaceDir`, use
  `useSessionWorkspaceDir(store.workspaceDir, tab.sessionId)`. Mint `tab.sessionId` via
  `codeApi.setTabSessionId` on first render when absent (replaces the mint in
  `use-chat-auto-launch`). The hook is called unconditionally (pass `null` base for non-chat
  tabs) to keep hook order static.
- **Agent workspace root**: same container-awareness as columns —
  `profileRunsOnHost(profile) ? scratchDir : '/workspace'` (no mountName for chat). This is a
  deliberate behavior alignment: today Chat passes the host path even for containerized
  profiles; the column logic is the correct one.
- **Projectless branch**: currently `!tab.projectId` → `CodeEmptyState` (project picker). New
  order: `isChatTab(tab)` branch FIRST (never shows the picker), then the existing empty-state
  branch.
- **Idle/pre-launch**: chat mode renders today's `ChatShell` (greeting, error/retry, Launch +
  `SandboxPicker` gated on `store.workspaceDir`) where columns show the spinner pill. The
  greeting (`getGreeting()`) is passed through `CodeWorkspaceLayout` → `OmniAgentsApp`
  (add a `greeting?: string` pass-through prop to `CodeWorkspaceLayout`/`CodeRunningView`;
  undefined for columns, unchanged behavior).
- **Minimal mode**: chat mode does NOT set `uiMinimal` (keeps the header hamburger +
  Conversations drawer exactly as today). Columns keep `uiMinimal`.
- **Variables**: chat mode builds `buildSessionVariables({ surface: 'chat' })` (+ the voice
  persona variant), columns keep the `surface: 'code'` + context build.
- **PR banner**: chat mode renders `PullRequestBanner scope={{ kind: 'chat' }} floating` as
  today; columns keep their scope.
- **Dock**: chat mode renders the dock inline at the bottom of the full-screen surface (no
  `dockTargetId`; `CodeWorkspaceLayout` already renders `EnvironmentDock` inline when no portal
  target is provided — verify, else add the inline fallback). Desktop app provides VNC.
- Everything else (status banner, activity ping keyed by tab id = `'chat'`, switch scrim,
  containerId capture effect, sandbox label/options, profile change via `codeApi.setTabProfile`,
  session change via `codeApi.setTabSessionId`) is the existing column code, now shared.

### 4. `Chat.tsx` — thin wrapper

Shrinks to: resolve the chat tab from `store.codeTabs` (`find(isChatTab)`; render nothing until
the migration-created record exists), wrap in the glass root class, render
`<CodeTabContent tab={chatTab} isVisible activeApp=... onActiveAppChange=... />` with local
`useState` for the active dock app. Deleted outright: `SandboxRunningView`, the duplicated
switch scrim styles/JSX, sandbox label/options building, profile/session/container handlers,
`use-chat-auto-launch.ts`, `Chat/state.ts` (`$chatProcessStatus`/`$chatProcessXTerm` — no
consumers outside the deleted files), and `FloatingWidget` usage here (if `FloatingWidget` has
no other consumers, delete the component too).

### 5. `codeApi` and deck guards

- `addTab` blank-tab reuse: exclude `isChatTab` from the "existing unconfigured tab" match
  (otherwise New Session would hijack the chat record, whose `projectId` is null).
- `removeTab`: guard — `removeTab(CHAT_TAB_ID)` is a no-op (defensive; no UI offers it).
- `reorderTabs`: **trap** — the deck calls it with its filtered list and the method overwrites
  the whole array, which would silently delete the chat record. Change `reorderTabs(next)` to
  write `[...stored.filter(t => !next.some(n => n.id === t.id)), ...next]` — i.e., preserve
  any stored tab missing from the input (only the chat record qualifies), keeping it at the
  front.
- `CodeDeck`: `tabs = (store.codeTabs ?? []).filter(t => !isChatTab(t))` before the existing
  `customAppPartition`. This single filter implements decision #2.
- `Code/state.ts` `pollStatuses`: now covers the chat entry (it has no `customAppId`); remove
  the dedicated `poll('chat')` interval from `services/agent-process.ts`.

### 6. Main process

- Snapshot GC (`main/index.ts`): delete the `chatSessionId` special case — the `codeTabs` loop
  now protects the chat session by construction. TTL semantics unchanged.
- No `ProcessManager` changes: process id stays `'chat'` because the tab id is `'chat'`.
- `project-manager` / `supervisor-orchestrator` `codeTabs` consumers filter by `ticketId` or
  explicit tab id — unaffected by an extra projectless record.

### 7. Voice and activity

- `CHAT_VOICE_SCOPE` (`'chat'`) stays; `CodeTabContent`'s `VoiceScopeContext.Provider
  value={tab.id}` now supplies the identical scope string for the chat tab, so `VoiceHotkeys`,
  the local-voice glow, and `column-activity` publishing need no changes. Remove the now-dead
  `VoiceScopeContext.Provider` in `Chat.tsx`.

## Interface Changes

```ts
// shared/types.ts
export const CHAT_TAB_ID = 'chat' as const;
export const isChatTab = (tab: Pick<CodeTab, 'id'>): boolean => tab.id === CHAT_TAB_ID;

// CodeWorkspaceLayout / CodeRunningView — new optional pass-through
greeting?: string;

// codeApi.reorderTabs — semantics change (signature unchanged):
// preserves stored tabs absent from `nextTabs` (chat record) at the front.
```

No IPC contract changes. No main-process API changes. Store schema: three keys removed (v26).

## Test Plan

Unit (vitest):
- `project-migrations.test.ts` v26: synthesizes the chat record from the three legacy keys
  (and mints a sessionId when `chatSessionId` was null); deletes the keys; idempotent when the
  record already exists; bumps `schemaVersion` to 26; ladder/idempotency assertions move to 26.
- `Code/state.test.ts`: `addTab` does not reuse the chat record as a blank tab;
  `reorderTabs` with a chat-less list preserves the chat record at the front;
  `removeTab(CHAT_TAB_ID)` is a no-op.

Live smoke (browser/server mode, desktop + 390px):
- Existing conversation survives the migration (same session id, transcript loads, container
  reattaches or falls back cleanly).
- Chat tab: conversation renders, Conversations drawer opens/searches/switches (switch →
  sandbox restart on the new scratch dir, transcript intact), profile switch shows the in-place
  scrim, dock appears with Code/Desktop/Browser/Terminal, Desktop app shows the VNC surface
  (no floating chip), composer chips correct ("Workspace", profile label).
- Spaces deck: chat column NOT visible; drag-reorder of two columns does not delete the chat
  record (inspect `codeTabs` after); New → Session still reuses a genuine blank tab.
- Voice: mic button in Chat records and speaks (scope `'chat'` end-to-end).
- Baseline discipline: tsc error count and eslint findings on touched files at or below
  current baseline; targeted suites only.

## Assumptions (defaults chosen)

- **App catalog / global agent**: the chat column now appears in the global agent's
  `allColumns` view (`app-catalog-core.ts` filters only `customAppId`). Treated as desirable —
  the global voice agent is a superuser over all columns, and chat is now a column. No filter
  added.
- **Chat keeps its dedicated nav tab and full-screen layout**; only its internals are unified.
  `layoutMode === 'chat'` and the Sidebar tab are untouched.
- **Scratch-workspace semantics stay chat-only** (keyed on `isChatTab`), not generalized to
  projectless columns — those keep the project picker.
- **`FloatingWidget`** is deleted only if Chat was its last consumer (verify at implementation;
  `Omni/FloatingWidget` may have other uses).
- **ChatShell stays** as the chat-mode idle branch; Phase 3 (onboarding) will revisit it.
- Single atomic change set (one commit/PR), per the repo's no-compat-layer convention: legacy
  keys, hooks, and components are removed in the same change that lands the unified path.

## Implementation Order (single PR, reviewable commits)

1. `CHAT_TAB_ID`/`isChatTab` + migration v26 + store schema/type removal + migration tests.
2. `CodeTabContent` chat-mode branches + `CodeWorkspaceLayout` greeting/inline-dock plumbing.
3. `codeApi` guards (`addTab`, `removeTab`, `reorderTabs`) + deck filter + polling consolidation
   + snapshot-GC simplification + state tests.
4. `Chat.tsx` rewrite to the thin wrapper; delete `use-chat-auto-launch.ts`, `Chat/state.ts`,
   `SandboxRunningView`, dead styles, (maybe) `FloatingWidget`.
5. Live smoke per test plan; commit.
