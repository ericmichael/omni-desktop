# Plan: Global Voice Agent for Tile Mode

> Status: **IMPLEMENTED** 2026-06-04 (Electron path; server-mode persistence
> rides the generic process path). All six workstreams landed. Originally
> captured from a design discussion the same day. See "Implementation notes" at
> the bottom for what shipped and where, plus deviations from the plan.

## Goal

A persistent, headless agent session — booted on the **Devbox** profile,
voice-first — reachable from a top-right affordance in Tile mode. It has read
context over _everything_ (projects / tickets / inbox / pages via the existing
`omni-projects-mcp`; open columns, sessions, sandbox profiles, and running apps
via new runtime tools) and can act on the user's behalf: spin up / close
columns, launch apps, drive **any** column's apps (superuser), and control any
column's agent (send message, approve / reject, cancel, toggle autopilot).

The north star is a voice-/VR-first shell where the agent operates the _same
action surface the GUI does_ (client tools), freeing the user from
keyboard/mouse. Nothing VR-specific is needed now; the client-tool substrate is
what makes it possible later.

## Why this fits the existing architecture

The client-tool substrate is already the right abstraction; most of the lift is
new tools + one new scope, not new runtime machinery.

- `buildSessionVariables` / `buildClientToolHandler` (`src/lib/client-tools.ts`,
  `src/renderer/features/Tickets/client-tool-handler.ts`) already give a session
  project/ticket/inbox/page CRUD (MCP), supervisor lifecycle
  (`start_ticket`/`stop_ticket`), the `app_*` automation suite, `browser_*`
  tabset control, `display_plan`, and `speak`.
- Scope is already a filter: `buildClientToolHandler({ tabId, allowGlobal })` +
  `listLiveApps`/`resolveAppHandle` (`AppControl/live-registry.ts`) distinguish
  "your column" vs "global dock."
- Voice is already a per-scope, client-tool round-trip: `speak` synthesizes
  locally via `VoiceService` (ONNX sidecar), the mic is a registered per-scope
  control (`getVoiceMic(scope)` in `voice-recording.ts`), and `VoiceHotkeys`
  routes a global hotkey to a resolved scope.
- Sessions are not bound to columns at the process layer: `ProcessManager` keys
  agents by arbitrary string id (`"chat"` is already a non-`CodeTab` session). A
  reserved `"global"` id with its own session + Devbox profile + voice-on is a
  natural fit. In server mode, `persistentSessions` keeps such a session alive
  across reconnects/remounts.

## Architecture decisions (the calls made)

- **The global agent is a normal `AgentProcess`** keyed by reserved id
  `"global"` (alongside `"chat"` and the `CodeTabId`s). No new runtime type. It
  runs **headless** — no `CodeTab`, no webview column.
- **New `surface: 'global'`** in `buildSessionVariables` selects the superuser
  tool set. Keeps the chat/code/global split in one place
  (`src/lib/client-tools.ts`).
- **App addressing diverges by scope:** column agents keep bare `app_id`
  (unambiguous in one column); the global agent addresses by **`handleId`**
  (`tab-<tabId>:terminal`), which `make/parseAppHandleId`
  (`src/shared/app-control-types.ts`) already produce. No ambiguity, no new
  param plumbing on every `app_*` tool.
- **Approvals for the global agent surface in its own panel** (the top-right
  overlay), reusing the existing `REQUEST_APPROVAL` flow from the chat-session
  machine. Read/observe tools are `safe`; mutations (close column, cancel run)
  prompt there or voice-confirm.
- **Voice availability follows `isLocalVoiceCapable()`** — works in Electron
  (local + cloud-linked) and self-hosted server; **not** the Azure
  browser/server deployment. The affordance hides there.

## The `list_apps` bug this also fixes

`list_apps` is built purely from `$liveApps`, which only gets an entry when a
`<Webview>` actually **mounts** and calls `registerApp` (`Webview.tsx`). Dock
apps mount lazily, so an agent can't tell it _could_ open VNC/code-server until
something already mounted it. Two sources exist:

- **Running set** = `$liveApps` = mounted webviews (all `list_apps` returns today).
- **Available catalog** = `buildAppRegistry(customApps)` (BUILTIN_APPS + custom),
  per-column availability gated in `EnvironmentDock` by
  `app.scope === 'sandbox' ? !!sandboxUrls[key] : true` and `columnScoped`.

The fix: `list_apps` returns the catalog filtered to the caller's scope with
running/available state annotated, not just the running set.

---

## Scope / permission model

| Caller           | Global apps | Own column apps | Other columns' apps     | Column-control tools | `list_workspace` |
| ---------------- | ----------- | --------------- | ----------------------- | -------------------- | ---------------- |
| Column agent     | drive       | drive           | —                       | —                    | —                |
| Autopilot agent  | —           | own column only | —                       | —                    | —                |
| **Global agent** | drive       | n/a (owns none) | **drive (by handleId)** | **yes**              | **yes**          |

The global agent is an app **superuser**: it owns no column-scoped apps but can
drive _any_ column's terminal / code-server / VNC. Because `app_id` (e.g.
`"terminal"`) is no longer unique across columns for this caller, it addresses
apps by `handleId`.

`buildClientToolHandler` gains a `superuser` flag (set for `surface: 'global'`)
that flips the app filter to an `allColumns` mode, enables handle addressing,
and unlocks the `column_*` + `list_workspace` tools.

## Mode availability

| Mode                         | Global agent     | Voice                                                  |
| ---------------------------- | ---------------- | ------------------------------------------------------ |
| Electron (local)             | yes              | yes — local sidecar                                    |
| Electron (cloud-linked)      | yes              | yes — local sidecar (`speak` round-trips to host)      |
| Browser/server (self-hosted) | yes              | yes — local sidecar on server host                     |
| Browser/server (Azure cloud) | yes (agent runs) | no — affordance hidden (`isLocalVoiceCapable()` false) |

---

## Workstreams

### A — Global session host

**New:** `src/renderer/features/Omni/` (or a new `GlobalAgent/` feature) owns the
headless session lifecycle.

- Singleton controller that, on first activation, starts an `agent-process` with
  `processId: "global"`, `profileName: <user Devbox profile>`, and
  `variables = buildSessionVariables({ surface: 'global', voice: true, personaInstructions })`.
- Instantiates the same `omniagents-ui` machinery a column uses — an `RPCClient`
  bound to the `"global"` process + a `useChatSession(client)` actor — but
  renders into a **compact panel** (transcript + voice orb), not a full column.
- In server mode, register in `wireGlobalHandlers` so the session lands in
  `persistentSessions` and survives WS reconnect/remount
  (`src/server/managers.ts`).
- Lifecycle: lazy-start on first open; keep warm; Devbox profile for a real
  shell/tools.

**Touches:** `src/main/process-manager.ts` (confirm `"global"` id doesn't
collide), `src/renderer/services/store.ts` (optional `globalAgentSessionId?`).

### B — Affordance + global voice scope

- **New:** top-right button in the Tile shell header that opens the
  global-agent panel and arms its mic.
- Add `GLOBAL_VOICE_SCOPE` to `src/renderer/services/voice-recording.ts` and
  register a mic control for it (registry already supports arbitrary scopes via
  `getVoiceMic(scope)`).
- Extend `resolveTargetScope()` in `src/renderer/features/Voice/VoiceHotkeys.tsx`:
  when the global panel is focused/open, the hotkey targets `GLOBAL_VOICE_SCOPE`
  instead of the hovered column. `speak` already round-trips to `VoiceService`.

### C — Fix `list_apps` (catalog + state) and add superuser scope

1. **`live-registry.ts` superuser filter.** Extend the filter from
   `{ tabId?, allowGlobal }` to also accept `{ allColumns: true }`. In that mode
   `listLiveApps` returns every entry, and `resolveAppHandle` resolves by full
   `handleId` (still accepts global ids).
2. **`list_apps` returns catalog + running state, scoped.** Merge the available
   catalog (`buildAppRegistry(customApps)` filtered to the caller's scope, same
   availability gate `EnvironmentDock` uses) with the running set from
   `$liveApps`. Output gains `running: boolean`, `available: boolean`, and
   (superuser only) `handleId` + column context (`tabId`, session id,
   project/ticket label) so N terminals are distinguishable.
   - Column agent: own scoped apps + globals, bare `app_id`, contract unchanged
     aside from the new flags.
   - Global agent: catalog + running across all columns + globals, by `handleId`.
3. **`app_*` dispatch honors superuser addressing.** In `client-tool-handler.ts`,
   when built with superuser scope, `resolveAppHandle` accepts a `handleId`
   directly. Column agents untouched.

**Touches:** `src/renderer/features/AppControl/live-registry.ts`,
`src/renderer/features/Tickets/client-tool-handler.ts`, tool descriptions in
`src/lib/client-tools.ts`.

### D — `launch_app` tool

"Available but not running" is only useful if it can be brought up (an unmounted
app has no `handleId`, so it isn't drivable yet).

- New client tool `launch_app(app_id, { tab_id? })`:
  - Column agent: mounts/activates the app in its own column.
  - Global agent: `tab_id` selects which column to mount it in (or a global app).
- Backed by existing `codeApi` actions (`addAppTab`, set active app). The dock
  mounts the webview on activation, which fires `registerApp`, after which
  `app_*` works.

**Touches:** `src/lib/client-tools.ts`, `client-tool-handler.ts`, small additions
to `src/renderer/features/Code/state.ts` to activate a dock app by id.

### E — `list_workspace` (runtime introspection)

MCP knows projects/tickets/inbox/pages; it does **not** know the launcher's
runtime. New tool reads `codeTabs` from the store:

- `list_workspace()` -> per open Tile column:
  `{ tabId, sessionId, profileName (sandbox profile), projectId/label,
ticketId/title, customAppId?, running apps }`, plus the global dock apps.

**Touches:** `src/lib/client-tools.ts` (def, global surface only),
`client-tool-handler.ts` (reads `persistedStoreApi`).

### F — Column-control tools + session-control registry

Each column's `omniagents-ui/App` already owns an `RPCClient` (bound to that
column's process) and a `useChatSession` machine. The global agent reaches into
a _target_ column's client.

1. **New session-control registry** (mirrors the `$liveApps` / `getVoiceMic`
   pattern): each column registers, keyed by `tabId`, a small interface:
   `{ sendMessage(text), decideApproval(requestId, 'approve'|'reject', always?),
stopRun(), getRunState() }`. These delegate to the column's existing
   `RPCClient` (`startRun`, `toolApprovalResponse` / `mcpApprovalResponse`,
   `stopRun`) and its `chat-session` machine (`SUBMIT`, `APPROVAL_DECIDED`,
   `STOP`).
2. **New global-only client tools** dispatching through the registry:
   - `column_send(tab_id, message)` -> `startRun` on the target.
   - `column_decide(tab_id, request_id, decision)` -> approve/reject a pending
     tool call.
   - `column_cancel(tab_id)` -> `stopRun`.
   - Autopilot start/stop reuse the **existing** `start_ticket`/`stop_ticket`
     (already wired in `ticketApi`).

**Touches:** new `session-control-registry.ts`, registration in the column's
App/`useChatSession`, defs in `src/lib/client-tools.ts`, dispatch in
`client-tool-handler.ts`.

---

## Sequencing

1. **C + D** first — `list_apps` catalog/state fix + superuser scope +
   `launch_app`. Self-contained, independently testable, improves _existing_
   column agents too.
2. **A + B** — headless global session host + affordance + voice scope. Now
   there's something to talk to.
3. **E** — `list_workspace`. Cheap, high-value context.
4. **F** — column-control registry + tools. Highest-risk; do last when the rest
   is stable.

## Testing

Vitest is the project's main surface (unit, manager-level via the electron shim).

- Pure/unit: `buildSessionVariables({ surface: 'global' })` emits the superuser
  tool set + correct `safe_tool_overrides`; `live-registry` superuser filter +
  handle resolution; `list_apps` catalog/running merge; `make/parseAppHandleId`
  round-trips for addressing.
- Manager-level: the `"global"` process boots on Devbox and registers in
  `persistentSessions` (server mode).
- Column-control registry: target resolution + delegation to a stubbed
  `RPCClient`.

## Open questions

1. **Global-agent approval UX.** Read tools are `safe`; for mutations, modal
   approvals in the panel vs voice-confirm ("should I close the staging
   column?") with only destructive ops gated. Lean: voice-confirm + a visible
   action log, to keep cognitive overhead low.
2. **One global session or per-window?** Matters only in multi-window Electron /
   multi-client server. Default: one per client/`sessionId`.

## Key file anchors

- Tool defs + `buildSessionVariables`: `src/lib/client-tools.ts`
- Client-tool dispatch: `src/renderer/features/Tickets/client-tool-handler.ts`
- Live app registry + scope filter: `src/renderer/features/AppControl/live-registry.ts`
- App handle scope + id helpers: `src/shared/app-control-types.ts`
- App catalog: `src/shared/app-registry.ts`
- Per-column dock availability gate: `src/renderer/features/Code/EnvironmentDock.tsx`
- Code tab/column actions: `src/renderer/features/Code/state.ts`
- Voice scope/mic registry: `src/renderer/services/voice-recording.ts`
- Global voice hotkey routing: `src/renderer/features/Voice/VoiceHotkeys.tsx`
- Local voice service (sidecar): `src/main/voice-service.ts`
- Voice capability gate: `src/renderer/services/voice-client.ts` (`isLocalVoiceCapable`)
- Per-column RPC client (startRun / toolApprovalResponse / stopRun): `src/renderer/omniagents-ui/rpc/client.ts`
- Per-column session machine + events: `src/shared/machines/chat-session.machine.ts`, `src/renderer/omniagents-ui/hooks/use-chat-session.ts`
- Server-mode persistent sessions / wiring: `src/server/managers.ts`

---

## Implementation notes (what shipped)

Landed across the six workstreams. New files marked ✚; the rest are edits.

**Shared tool layer (C-1)**

- `src/lib/client-tools.ts` — added `launch_app` (to `CODE_UI_TOOLS`), the
  `WORKSPACE_CLIENT_TOOLS` set (`list_workspace`, `open_column`, `close_column`,
  `column_send`, `column_decide`, `column_cancel`), `surface: 'global'` +
  `GLOBAL_GUIDANCE`. `close_column` is the only non-`safe` one (needs approval).
- `src/lib/client-tools.test.ts` — global-surface + safe-set coverage.

**list_apps catalog + superuser scope (C)**

- ✚ `src/renderer/features/AppControl/app-catalog-core.ts` — pure `buildAppCatalog`
  (merges registry catalog + `$liveApps` running set, gates sandbox apps by
  per-column `services`). Split from the live wrapper so it's testable without
  the ipc/localStorage import chain.
- ✚ `src/renderer/features/AppControl/app-catalog.ts` — live wrapper
  `listAppsForScope`.
- ✚ `src/renderer/features/AppControl/app-catalog.test.ts`.
- `live-registry.ts` — `allColumns` superuser mode + handleId addressing in
  `listLiveApps` / `resolveAppHandle`.
- `src/shared/app-control-types.ts` — `AppScopeFilter.allColumns`.
- `client-tool-handler.ts` — `list_apps` uses the catalog; `superuser` flag on
  `buildClientToolHandler` sets the `allColumns` filter.

**launch_app (D)**

- ✚ `src/renderer/features/AppControl/app-launch-bridge.ts` — `requestAppLaunch`
  atom bridge (mirrors `preview-bridge`).
- `CodeDeck.tsx` — listener that _opens_ (not toggles) the requested dock app.
- `client-tool-handler.ts` — `handleLaunchApp` (own-column for column callers,
  any column for superuser, handleId-aware).

**Workspace + column tools (E, F)**

- ✚ `src/renderer/services/session-control.ts` — tab-keyed controller registry
  (`sendMessage` / `decideApproval` / `stopRun` / `getState`).
- ✚ `src/renderer/services/session-control.test.ts`.
- `omniagents-ui/App.tsx` — builds a `SessionController` from its client +
  chat-session machine, hands it up via a new `onController` prop.
- `omniagents-ui/LauncherApp.tsx` — forwards `onController`.
- `CodeWorkspaceLayout.tsx` — registers the controller by `tabId`.
- `client-tool-handler.ts` — `handleWorkspaceTools` (`list_workspace` reads
  codeTabs + statuses + run states; `open_column`/`close_column` via `codeApi`)
  and `handleColumnTools` (`column_*` via the registry), both superuser-gated.

**Global session host + affordance + voice (A, B)**

- ✚ `src/renderer/features/GlobalAgent/state.ts` — `"global"` process id,
  `devbox` profile, localStorage session/container id, `$globalAgentOpen`,
  `$globalProcessStatus`.
- ✚ `src/renderer/features/GlobalAgent/use-global-auto-launch.ts` — reuses the
  generic `useAutoLaunch` hook.
- ✚ `src/renderer/features/GlobalAgent/GlobalAgentPanel.tsx` — boots the session,
  hosts `OmniAgentsApp` with `surface: 'global'` vars, voice vars, the superuser
  handler, wrapped in `VoiceScopeContext = GLOBAL_VOICE_SCOPE`.
- ✚ `src/renderer/features/GlobalAgent/GlobalAgent.tsx` — top-right FAB +
  slide-out panel; only in Tile (`layoutMode === 'spaces'`); panel mounts lazily
  on first open and stays mounted.
- `services/voice-recording.ts` — `GLOBAL_VOICE_SCOPE`.
- `Voice/VoiceHotkeys.tsx` — open orchestrator panel claims the voice hotkey.
- `app/App.tsx` — mounts `<GlobalAgent />`.

## Deviations from the plan

- **`list_apps` enrichment is universal.** The new `running`/`available`/
  `handle_id`/`app_id` fields are returned to _all_ callers (additive, backward-
  compatible); column callers still address by bare `id`.
- **No store-schema migration.** The orchestrator's session/container id live in
  `localStorage` (renderer-local), not a new `StoreData` key — avoids a schema
  migration for a non-synced concern.
- **Controller registered from `CodeWorkspaceLayout`, not App self-registration.**
  Keeps omniagents-ui decoupled (App only exposes an `onController` callback; the
  launcher side owns the tabId-keyed registry).
- **launch_app targets column-scoped apps only** (terminal/code/desktop/browser).
  Global custom apps are driven directly via `app_*` once visible.
- **Approval UX (open question #1):** read tools are `safe`; `close_column` is the
  one gated mutation. Voice-confirm vs modal approvals for other mutations is not
  yet specialized — they currently run as `safe` and the agent is told to confirm
  destructive actions in `GLOBAL_GUIDANCE`.

## Known follow-ups (not blocking)

- Server-mode (`wireGlobalHandlers`) persistence parity for the `"global"`
  session is currently implicit via the generic agent-process path; a dedicated
  `persistentSessions` wire-in could harden reconnect survival.
- No automated UI test for the panel/affordance (consistent with the repo's
  unit-only suite); the logic-bearing pieces (catalog, registry, tool defs) are
  unit-tested.

## Per-session scratch workspace (Chat + Orchestrator)

Ambient surfaces are not bound to a project, so mounting the whole
`store.workspaceDir` tree gave them more reach than they need. Both **Chat** and
the **Orchestrator** now boot in an isolated **`<workspaceDir>/Sessions/<sessionId>`**
dir instead.

- New IPC `util:session-workspace-dir(baseDir, sessionId)` (`shared/ipc-handlers.ts`)
  joins + ensures the dir (id sanitized to one safe path segment) — works in
  Electron and server mode.
- New hook `useSessionWorkspaceDir` (`src/renderer/hooks/`) resolves it; returns
  `null` until ready, which naturally gates `useAutoLaunch` from launching early.
- Wired into `useChatAutoLaunch` and `useGlobalAutoLaunch`; the resolved dir is
  also surfaced to the workspace chip (Chat) so it matches the real mount.
- `sessionId`: Chat uses its persisted `chatSessionId`; the Orchestrator uses its
  localStorage global session id. Both are stable, so each surface has a stable
  scratch home. (Known nuance: Chat's mounted dir is fixed at boot, so switching
  to a _new_ chat conversation within the same running process keeps the boot
  session's dir — the process doesn't relaunch on session switch.)

## Conversation inspection (orchestrator situational awareness) — Read-shaped

`list_workspace` gave coarse run-state but no view into what each column's agent
was doing. The first cut of `column_transcript` failed agentic-tool best
practices (silent lossy truncation, newest-N-only, no addressing/pagination,
and `list_workspace` baked a derived summary). Reworked to mirror the `Read`
tool's contract — faithful, bounded, addressable, recoverable:

- **`column_transcript(tab_id, offset?, limit?)`** → a window over the full
  ordered transcript: `{ total, offset, entries, has_more_before, has_more_after }`,
  each entry tagged with its absolute `index`. Defaults to the tail; `offset`
  pages backward through history (like `Read`'s line window over a file).
- **No silent truncation.** Fields cap at 2000 chars and the entry's
  `truncated` map records each cut field's FULL length — loss is visible and
  quantified, never a bare `…`.
- **`column_read_entry(tab_id, index)`** → one entry, untruncated. The
  byte-complete recovery path for anything `column_transcript` flagged as
  truncated. (The `Read` analogy at the entry level.)
- **`list_workspace` stops pre-digesting.** Per column it now returns
  `transcript: { total, last: { kind, role?, tool?, status? } }` — a structured
  pointer at the newest entry, not an interpreted one-line string. The agent
  drills in with `column_transcript`.

Pure helpers (`transcriptPage`, `fullEntry`, `lastEntrySignal`) live in
`session-control.ts`, unit-tested for mapping, tail-default, backward paging,
quantified truncation, and full-entry recovery. `App.tsx` exposes them via the
controller's `getTranscript()` / `getEntry()` and the `transcript` field on
`getState()`.

### Stable cursors for incremental polling

`index` was a live-snapshot address — deciding an approval removes its entry and
shifts later indices, so "everything since N" wasn't reliable. Replaced with a
stable **`cursor`** per entry (`createCursorAssigner`, one per column): tool
entries key on `call_id` (so the cursor is stable across `called`→`result`,
where the item object is replaced), approvals on `request_id`, and chat/artifact
on object identity (never replaced). Cursors are monotonic in append order and
survive removals.

- **`column_transcript(tab_id, after?, before?, limit?)`** → `{ total, latest_cursor, entries, has_more }`, each entry carrying a `cursor` (+ a live `index`). `after: <cursor>` polls forward for only what's new (empty = caught up); `before: <cursor>` pages backward; neither = the tail. `latest_cursor` is the high-water mark.
- **`list_workspace`** returns each column's `latest_cursor`, so the orchestrator can sweep, see which columns advanced, and `column_transcript(after:)` only those.
- **`column_read_entry(tab_id, cursor)`** addresses by cursor too; returns null if that entry was since removed.

Unit-tested invariants: cursor stable across tool `called`→`result`; surviving
entries keep their cursor after an approval is removed; `after`/`before` paging;
quantified truncation; cursor-addressed full reads.

## Push-driven orchestrator wakeups (cross-session notifications)

The cursor polling above is the _pull_ half; this is the _push_ half. When the
orchestrator dispatches to a column via `column_send`, it's now woken when that
column's run ends — instead of polling `list_workspace`. This reuses
omni-code/omniagents' existing background-notification machinery (the same path
bash jobs and workers use: `service.enqueue_notification` → batched,
role="assistant", triggers a fresh run), bridged across sessions (column and
orchestrator run in separate agent processes).

**Delivery uses the existing `enqueue_message` RPC** — no omni-code change.
`SessionController.notify` calls `client.enqueueMessage(sid, content, { role:
'assistant', triggerRun: true })`, which is exactly what omniagents'
notification flusher calls internally to deliver a wakeup (role="assistant"
history item → drainer → `start_run(prompt_role="assistant")`). This works
against the released/pinned runtime; an earlier attempt used a new
`notify` server function, but server functions are gated by an explicit
allowlist in `agent.yml` (`server_functions:`) — the file was discovered yet
never registered (I'd added `notify.py` but not `- notify` to the agent.yml
list), so `server_call('notify')` raised `Unknown server function` and the
best-effort catch swallowed it. `enqueue_message` is a built-in service method
(not allowlist-gated), so it needs no agent.yml/omni-code change.

**launcher**:

- `SessionController.notify(content, source)` → `client.serverCall('notify', ...)`
  on that session (added in `App.tsx`).
- A column run-end push channel: `App` fires `onRunEnd` from its `run_end`
  handler → `CodeWorkspaceLayout` calls `emitColumnRunEnd(tabId, info)` →
  `session-control` fans out to `onColumnRunEnd` listeners.
- `GlobalAgent/orchestrator-watch.ts` (new): holds the orchestrator's controller
  (registered via the panel's `onController`) + a watch set. `column_send`
  registers `watchColumnRun(tabId, runId)`; on that column's run-end it pushes a
  framed wakeup (`"[column <id>] … review with column_transcript(after:) …"`,
  source `column.done`) to the orchestrator. One-shot. Pinning is run-id-exact: an **idle** dispatch uses the `run_id`
  `column_send` returns; a **queued** dispatch (column busy → no `run_id` yet)
  arms and captures the real `run_id` from the column's next `run_started`, so
  the run our dispatch is queued _behind_ never fires the wakeup. Run-started/
  run-end flow through new `onColumnRunStarted`/`onColumnRunEnd` channels in
  `session-control` (emitted from `App`'s run lifecycle via `CodeWorkspaceLayout`).
  Unit-tested (`orchestrator-watch.test.ts`), incl. the queued-behind case.

Net: the two halves compose — `latest_cursor` from `list_workspace`/the wakeup
tells the orchestrator a column advanced; `column_transcript(after:)` reads only
what's new. The orchestrator no longer polls.

Caveat: the wakeup requires the orchestrator session to be alive (panel opened at
least once, its RPC client connected); `notify` is best-effort and swallows
errors if the orchestrator is down or on an older omni-code without the `notify`
server function.

## Terminal copilot (tmux-faithful)

So the orchestrator can help the user with _interactive_ terminal work (not
headless exec — column agents already have `bash` for that). Drives the
column's **visible** terminal, modeled on `tmux send-keys` / `capture-pane`.

- ✚ `src/lib/tmux-keys.ts` — pure `keysToBytes(keys, { literal, count })` mapping
  tmux-style tokens (`C-c`, `Enter`, `Up`, `M-b`, `F5`, … else literal) to bytes.
  Unit-tested.
- Tools (global/superuser, in `WORKSPACE_CLIENT_TOOLS`):
  - `terminal_send_keys(tab_id, keys, { literal?, count?, terminal_id? })` — `tmux send-keys`.
  - `terminal_capture(tab_id, { lines?, terminal_id? })` — `tmux capture-pane` (reads the xterm scrollback).
  - `terminal_list(tab_id)` / `terminal_open(tab_id)`.
- Handler (`client-tool-handler.ts`, superuser-gated) reuses the existing
  terminal path: resolves the pane via `$terminalsByTab`, writes input through
  `terminal:write` (the same channel the keyboard uses → visible + real PTY),
  and reads output from the live `xterm.buffer.active`.

Design decisions:

- **No `exec` / sentinel scraping.** The sandbox already solved reliable command
  execution via `workspace.exec` (`{stdout, stderr, exit_code}`), which the
  column's own `bash` uses. The copilot is the _opposite_ use case — drive the
  shared visible shell — so it accepts the PTY as a raw stream and reads "what's
  on screen."
- **tmux-faithful, no inter-key delay.** Tokens are sent back-to-back. Standard
  signals don't queue, so a guaranteed double-SIGINT (`["C-c","C-c"]` in one
  call) can coalesce; the tool tells the agent to send twice (+ `terminal_capture`
  between) for that, same as scripting tmux.
- **`terminal_send_keys` is `safe`** (no per-call approval) for voice-first
  usability, with `GLOBAL_GUIDANCE` instructing the agent to confirm destructive
  actions — a deliberate friction/usability tradeoff worth revisiting.
