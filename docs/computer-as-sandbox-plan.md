# Computer-as-Sandbox: Implementation Plan

Decision-complete implementation plan for adding "computer-as-sandbox" to the
cloud-linked Electron mode. The user picks, per session, between cloud-ACI
compute and "my laptop" compute. The cloud server stays the source of truth
for session metadata + agent message history; the laptop is just an
alternative compute backend the cloud can dispatch sandbox lifecycle to.

This document is the spec the implementer follows without coming back for
clarification.

## Architecture decision: Shape A modified

Shape A as originally sketched ("tunnel every WS frame cloud↔laptop") is
wrong on one axis: it forces every keystroke into a 4-hop path (`renderer →
cloud → laptop → omni-serve → laptop → cloud → renderer`) when at least three
of those hops are physically redundant for the common case (renderer is on
the same laptop as omni-serve).

The validated shape is:

- **Control plane (Shape A)**: every `agent-process:*` IPC call from the
  renderer goes to the cloud `ProcessManager`, which dispatches to an
  `IComputeClient`. For a local-anchored session, the implementation of
  `IComputeClient` is a new `RemoteElectronComputeClient` that issues
  _reverse RPCs_ over the existing WS to the named Electron. Session
  metadata, chat history (omniagents `PgSessionStorage`), agent message
  persistence — all remain in cloud Postgres. This is the inversion of
  `PlatformClient`.
- **Sandbox data plane (Shape B-ish)**: when the cloud's
  `RemoteElectronComputeClient` resolves a local session to `running`, it
  returns a `wsUrl` + `uiUrl` pair that points **directly at the laptop**
  (via a reverse proxy mode on the cloud — see below). The renderer then
  opens its sandbox WS (the one that today carries `terminal:*`,
  `sandbox.notify_activity`, `sandbox.pause`, etc.) through this URL. When
  the renderer happens to be on the same laptop, it's same-host TCP. When
  the renderer is on a _different_ device (web UI from a phone), the URL
  points to a cloud-relayed path that forwards to the laptop's WS. One
  renderer code path; both physical topologies work.

Why this is the right call:

1. **Latency.** Today the renderer talks to `omni serve` directly via
   `data.wsUrl` (in Electron) or via `/proxy/chat/` (in browser cloud). Both
   are roughly 1 hop. Forcing every frame through cloud relay for the
   same-laptop case would regress chat latency by ~50–200ms RTT — a
   noticeable typing lag, and Codex token streaming would visibly slug.
2. **Cloud is still source of truth.** The cloud `ProcessManager` knows
   every session that exists, who it's anchored to, and its status. The
   cloud writes session metadata to PG. The agent's _workspace files_ are
   local-only by design — that's the whole point of the feature. The cloud
   doesn't need to see every Codex token.
3. **One renderer code path.** The renderer's sandbox WS attaches to
   `wsUrl` from `AgentProcessData`. We just need that URL to resolve to
   "wherever the agent actually is" — direct on same-laptop, cloud-relayed
   on cross-device. The existing `proxy-rewriter.ts` (`rewriteStatusUrls`)
   is already the place to do this rewriting; we extend it to recognize
   local-compute sessions and emit either a direct-LAN URL (if the renderer
   is the anchoring Electron) or a `/proxy/local/<machineId>/<sessionId>/...`
   cloud-relayed URL otherwise.
4. **Single WS to the cloud.** The renderer still has exactly one cloud WS;
   the sandbox WS is a separate connection it would have opened anyway
   (today's `ConsoleManager`, `oneShotServerCall`, etc. all open their own
   sockets to `data.wsUrl`).

The renderer never opens a second control-plane WS. The Electron-as-host
opens a control-plane WS to the cloud (the SAME WS the renderer in that
Electron already opens — they multiplex), and the cloud uses _reverse RPC_
over it to drive lifecycle.

## Open questions: decisions

### 1. Workspace bytes on cross-machine access — Option X

Read-only metadata + "Move to cloud" button. Periodic delta sync to Azure
Files is plausible but: (a) it doubles the cost in disk I/O on the laptop
with no clear ceiling; (b) it leaks files to the cloud the user explicitly
chose laptop-compute to avoid; (c) it creates a write-back conflict path we
don't want to design. The user picked "my laptop" — the workspace lives on
the laptop. Cross-device access shows a degraded read-only view (session
metadata, chat history from PG, last-known agent status) and a one-click
"Promote to cloud" affordance that drives the existing `sandbox.switch`
machinery cross-machine. The web-UI experience is honest: "This session is
anchored to Eric-MacBook (offline since 4:12pm). Open Eric-MacBook to
continue, or promote to cloud-ACI."

### 2. Settings inheritance on local compute — cloud settings always win

The user signed into the cloud; their identity, model keys, MCP, env, git
creds, codex tokens are all in cloud Postgres / `PgSecretStore`. When the
cloud dispatches `startSession` to the laptop, it ships the **already-
materialized** env bundle (the same bundle today's `getExtraEnv` produces
for ACI spawns — including `OMNI_RUNTIME_TOKEN`, model API keys, Codex JSON
contents, `XDG_CONFIG_HOME` redirect target, `.env`). The laptop's local
Electron's own settings (the standalone-Electron persisted config) are
_ignored_ for cloud-linked sessions. Two reasons: (a) consistency with
cloud-ACI — same agent behavior regardless of compute backend; (b)
eliminates "why did my OpenAI key change when I switched compute?"
surprises. The laptop's main process writes the materialized config to an
ephemeral per-session scratch dir under `<omni-config>/cloud-sessions/<sessionId>/`
and points the spawn's `XDG_CONFIG_HOME` at it; the dir is wiped on session
stop.

### 3. NAT / availability UX

Laptop sleep / lost network → laptop's cloud WS drops. The cloud
`RemoteElectronComputeClient` marks every session anchored to that machine
as `status=disconnected` (a new status; see Q8). The renderer's
`AgentProcessStatus` for those sessions surfaces an `error` status with
`error.kind: 'host-offline'` and a `hostMachineId` field. Renderer UI:
yellow banner "Eric-MacBook is offline. The session will resume when it
reconnects." No retry button — sessions auto-resume when the laptop's WS
reconnects. The cloud caches the most recent `running`-state
`AgentProcessData` (wsUrl, services, containerId) so when the laptop
reconnects, the cloud re-issues `compute:adopt-session` reverse RPCs and
any sessions that the laptop reports back as still-running flip from
`disconnected` → `running` without a full restart.

### 4. Multi-Electron-per-machine — last-WS-wins, session ownership is older binding

Same machine_id from two Electrons: the cloud `MachineRegistry` keeps the
most-recently-connected WS as the active dispatch target (last-wins for new
sessions). But any session already anchored to the machine stays bound; new
`compute:*` RPCs for that session go to whichever WS is currently active.
If the first Electron's WS reconnects, it overwrites the second as the
active target. This is correct because: (a) the two Electrons share local
Docker / `omni serve` processes via the actual OS — both can see the same
`docker exec` outputs; (b) any race condition between the two Electrons
would already exist today in standalone-Electron mode (two Electrons on
one machine sharing `~/.omni/`); (c) `last-wins` matches how
`WsHandler.persistentSessions` already handles client reconnection.
Document the trade-off — two windows on one machine isn't a primary use
case.

### 5. Multi-machine support — explicit per-machine pairing

First time an Electron with `cloudMode` set connects, it auto-registers:
(a) a stable `machineId` (UUID generated once, persisted in Electron's local
store), and (b) a friendly `label` (defaults to `os.hostname()`, editable in
Settings). The cloud stores these in a new `machines` PG table scoped per
principal. The picker (`SandboxPicker.tsx`) shows three families: `aci`,
`aci-desktop`, plus one entry per registered machine (`local:<label>` for
each, with a green/grey dot indicating live WS status). Approval is
implicit: the cloud knows the principal owns the machine because the
Electron's WS already carries the principal's signed token — no extra
approval step. Removing a machine is explicit (Settings → Machines →
Remove); removed machines lose the right to receive reverse RPCs even if
they reconnect with the same id.

### 6. Auth on reverse-RPC

The cloud-side checks (before sending a `compute:start-session`): (a)
session's `compute_location` resolves to a machine the _same principal_
owns; (b) the target machine WS's authenticated principal equals the
session's principal; (c) the operation is permitted for the session's state
(no `start` if `running`, etc.). The Electron-side check (before honoring
an incoming reverse-call): (a) the WS it received it on is the one _it_
dialed, with its own token (intrinsic — no impersonation possible); (b) the
operation is in a known allowlist (`compute:start-session`,
`compute:stop-session`, `compute:adopt-session`, `compute:get-status`); (c)
the requested `sessionId` is either unknown (start) or owned by this process
(rest). Reverse-RPCs are NOT delegated to `omni serve` — they only drive the
laptop's existing local `ProcessManager`, which already has every safety
check.

### 7. Workspace migration on compute switch — one-way promote-to-cloud only

`perform_switch` today snapshots within one omni-serve process; cross-
machine migration would require shipping a multi-GB tar over the user's
WAN, plus handling git state, plus deciding what happens to running
terminal sessions / shells / dev servers. Out of scope for v1.

The "Promote to cloud" affordance is implemented as: (1) `sandbox.snapshot.tar`
produced via existing snapshot machinery on the laptop; (2) uploaded via SAS
URL the cloud mints (same path `prepareWorkspace` uses today, but inverted —
the cloud is the _destination_ here, not source); (3) cloud's
`ProcessManager` starts a fresh `aci` session, restores the snapshot via the
existing `--snapshot-dir` path, captures the new `sessionId`. The renderer
treats the old (laptop) session as `archived` and the new (cloud) session as
a continuation in the same chat. Laptop-to-laptop and cloud-to-laptop
migrations remain "stop the old, start fresh" — no snapshot transport. We
can revisit in v2 when we have a single user complaining about it.

### 8. Long-running compute disconnect

If laptop's WS drops mid-conversation, the `omni serve` process on the
laptop keeps running (it's a normal local child process; nothing is bound
to the WS being open). Any chat messages the agent had already persisted to
cloud PG via the omniagents `PgSessionStorage` are durable. Messages in
flight at the moment of disconnect (e.g. the LLM is mid-stream when the WS
drops) are lost from the renderer's view but: (a) the agent will still
complete its turn and persist the final message to PG; (b) when the
renderer reconnects via cloud and the cloud re-adopts the session, the
renderer re-fetches the session history from `PgSessionStorage` and sees
the completed turn. This is exactly today's behavior for cloud-ACI sessions
when the user closes the browser mid-response. Streaming-mid-disconnect is
a UI smoothness loss, not a correctness loss.

### 9. Snapshot ownership

For laptop-hosted sessions: snapshot tar lives at `<omni-config>/snapshots/<sessionId>.tar`
on the laptop, same as today's standalone-Electron mode. No Blob upload by
default — the snapshot's purpose is local resume, and uploading is exactly
the workspace-leak we promised the user we'd avoid. The "Promote to cloud"
flow (Q7) opt-in uploads to Blob as a one-shot. Cloud-hosted (ACI) sessions
continue to push to Blob as they do today. Snapshot ownership = same
machine as the session's `compute_location`.

### 10. Renderer connection lifecycle

Renderer keeps its single control-plane WS to the cloud. For sandbox WS
(the `data.wsUrl` channel used by terminal proxy, sandbox lifecycle,
`notify_activity`), the renderer connects to whatever URL the cloud reports
— which the cloud sets to: (a) direct LAN URL when the cloud knows the
renderer's WS and the target machine's WS share an originating IP
(`request.socket.remoteAddress` parity); (b)
`/proxy/local/<machineId>/<sessionId>/...` cloud-relayed URL otherwise. In
Electron, the renderer's `serverOrigin()` is the cloud URL but the resolved
`wsUrl` can be a direct LAN URL (e.g. `ws://192.168.1.x:<port>/ws`) —
Electron has no CORS, so this works. In a browser opened cross-device, it
always lands on the cloud-relayed path. The cloud-relay path adds one WAN
hop; the LAN-direct path is identical latency to today's
standalone-Electron mode.

### 11. Web UI feature parity loss for local-anchored sessions

Lost (from a different device):

- Workspace file view (FilesPanel, code-server iframe) — Q1 explicit decision.
- noVNC desktop pane — same reason.
- `docker exec` operations the cloud `ProcessManager` does for PR diff /
  merge (`getProjectContainerId`) — these now hop laptop, so they show
  "host offline" if the laptop is offline.
- Snapshot blob restore on a fresh device — the snapshot is local-only.
- Cross-device "Open in code-server" — same as workspace.

Retained:

- Session list, chat history, ticket metadata, projects, milestones (all in PG).
- Read access to agent messages (streamed when the host was online; replayed
  from PG when offline).
- The "Promote to cloud" button (always works because all it needs is the
  cloud's API).

This is fine. The user explicitly traded one for the other.

### 12. Concurrency limits

Cap of 5 local-anchored sessions per machine. The local `ProcessManager`
has no limit today, but five concurrent omni-serve processes is already at
the upper end of practical (each spawns a docker container, holds open
ports, runs its own Python interpreter). Cap is configurable via
`OMNI_LOCAL_COMPUTE_MAX_SESSIONS` on the Electron's env. Failure mode at
cap: cloud's `compute:start-session` reverse RPC returns
`{error: 'machine_at_capacity', maxSessions: N, currentSessions: N}`; cloud
surfaces as `AgentProcessStatus.error` with a kind the renderer can show as
"Eric-MacBook is at capacity (5 sessions). Stop one, or switch this
session to cloud."

### 13. omniagents / omni-code changes needed — NONE

Pure launcher-side. This is the cleanest outcome:

- `omni serve` already does everything we need on the laptop: spawn a
  sandbox session, expose a WS, handle resume from snapshot.
- `perform_switch` is per-process and stays per-process. Cross-machine
  "switch" is implemented at the launcher layer as stop-old + start-new
  with optional snapshot migration (Q7) — `perform_switch` is never asked
  to swap machines.
- `omniagents.core.sandbox.factory` is unchanged; the laptop just resolves
  the `host`/`devbox`/`aci` profile against its own env (which won't have
  Azure config for `aci`, so it'll only get `host`/`devbox`).
- `PgSessionStorage` already supports cross-process / cross-machine access
  (it's a Postgres table); the laptop's `omni serve` just needs the same
  `OMNIAGENTS_HISTORY_URL` the cloud uses, which the cloud passes in
  `getExtraEnv` for the dispatched start (Q2).

## Phase plan

### Phase 1 — Machine identity + registration (3 days)

**Goal**: A cloud-linked Electron registers a stable `machineId` with the
cloud over its existing WS. Cloud lists machines per principal. No compute
dispatch yet.

**Files to create**:

- `src/main/machine-identity.ts` — generate + persist `machineId` (UUID v4,
  written once to `<omni-config>/machine.json`, never rotated). Read
  `os.hostname()` for default label.
  - Exports: `getOrCreateMachineIdentity(configDir): { machineId: string, label: string, platform: string }`
- `src/main/machine-identity.test.ts` — idempotency, persistence, hostname
  fallback.
- `packages/projects-db/src/pg/schema.ts` — add migration version 10:

  ```sql
  CREATE TABLE machines (
    machine_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    platform TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT ${TS_DEFAULT},
    last_seen_at TEXT NOT NULL DEFAULT ${TS_DEFAULT}
  );
  CREATE INDEX idx_machines_principal ON machines(principal_id);
  ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
  ALTER TABLE machines FORCE ROW LEVEL SECURITY;
  CREATE POLICY principal_isolation ON machines
    USING (principal_id = current_setting('app.current_principal', true))
    WITH CHECK (principal_id = current_setting('app.current_principal', true));
  ```

- `packages/projects-db/src/pg/machines.ts` — `MachinesRepo` class:
  `register`, `touch`, `list(principalId)`, `delete(principalId, machineId)`,
  `rename`. Exported from `index.ts`.
- `packages/projects-db/src/pg/machines.test.ts`
- `src/server/machine-registry.ts` — in-memory map of active
  `machineId → { ws, principalId, lastPingAt, sessionsAnchored: Set<string> }`.
  Wraps the PG repo; on register-via-WS, upserts PG row + binds active WS.
  On WS close, releases binding (but leaves PG row).
  - Exports: `MachineRegistry` class with
    `bindFromWs(ws, principalId, machineId, label, platform)`,
    `getActiveWs(machineId)`, `listForPrincipal(principalId)`, `release(ws)`.
- `src/server/machine-registry.test.ts`

**Files to modify**:

- `src/shared/types.ts` — add:
  - `IpcEvents['machine:register']: (info: { machineId, label, platform }) => Promise<{ accepted: boolean }>`
  - `IpcEvents['machine:list']: () => Promise<MachineSummary[]>`
  - `IpcEvents['machine:rename']: (machineId, label) => Promise<void>`
  - `IpcEvents['machine:remove']: (machineId) => Promise<void>`
  - `IpcEvents['machine:set-label']: (label) => Promise<void>` (the local
    Electron's _own_ label override)
  - `MachineSummary` type: `{ machineId, label, platform, online, isSelf, registeredAt, lastSeenAt }`
- `src/main/index.ts` — on app boot when `cloudMode != null`, call
  `getOrCreateMachineIdentity` and once cloud WS opens, invoke
  `machine:register`. Wire `cloud:get-machine-identity` IPC for the
  renderer's settings page.
- `src/server/managers.ts` — instantiate `MachineRegistry`, wire `machine:*`
  handlers, register on connect, release on disconnect. Pass registry into
  `wireClientManagers` so the WS knows its machine.
- `src/server/index.ts` — pass machine registry through.
- `src/renderer/features/SettingsModal/` — add `MachinesCard.tsx` (new)
  listing machines, allowing rename, remove. Wire from settings tree.

**Tests added**:

- `src/main/machine-identity.test.ts`
- `packages/projects-db/src/pg/machines.test.ts`
- `src/server/machine-registry.test.ts`
- `src/server/managers.test.ts` (new — minimal smoke for the registry wiring)

**Bicep**: none.
**Docs**: `infra/DEPLOY.md` — add a paragraph under "Cloud mode" noting
machines table exists for per-principal compute dispatch.
**Dependencies**: none (purely additive).
**Effort**: 3 calendar days.

### Phase 2 — Reverse-RPC over WS (2 days)

**Goal**: The cloud can send a reverse-RPC request to an Electron's WS and
await its response. No compute logic yet; just the transport.

**Files to modify**:

- `src/server/ws-handler.ts` — extend the wire protocol:
  - Add message types: `{type: 'reverse-invoke', id, channel, args}` (cloud
    → client) and `{type: 'reverse-response', id, result?, error?}` (client
    → cloud). Both directions reuse the same monotonic `id` space scoped
    per WS connection.
  - Add `WsHandler.invokeOnSession(sessionId, channel, ...args): Promise<unknown>`
    — picks the right WS, sends `reverse-invoke`, returns a promise resolved
    by the matching `reverse-response`. Times out after a configurable
    (default 30s) cap.
  - The existing `handleMessage` learns to route `reverse-response` to the
    pending-request map.
- `src/renderer/transport/ws-transport.ts` — in `ws.onmessage`, recognize
  `reverse-invoke`. Add `WsTransportEmitter.addReverseHandler(channel, handler)`.
  On `reverse-invoke`, dispatch to handler and send `reverse-response` with
  the result/error.
- `src/preload/index.ts` and Electron main: expose a thin `reverse:*` IPC
  adapter so main-process modules can register reverse handlers (not just
  the renderer). The renderer-side reverse RPC will be used for UI prompts
  later; main-side is what compute dispatch needs.

**Critical detail**: when the **Electron's main process** wants to register
a reverse handler (and the WS lives in the renderer's `WsTransportEmitter`),
we have a layering problem. Resolution: in cloud-linked Electron mode, move
the WS into main (already done logically since main fetches the ws-token);
add a `MainWsHandler` in `src/main/main-ws-client.ts` that owns the cloud
WS and exposes a forward-RPC channel to the renderer via IPC. This
consolidates: today's `WsTransportEmitter` runs in the renderer; we move it
to main and have the renderer proxy invokes/events through IPC. Strict win:
reverse handlers register in main (where compute lives); the renderer's IPC
pipe gets compute events for free.

**Files to create**:

- `src/main/main-ws-client.ts` — owns the cloud WS in main; forwards
  renderer IPC to WS invokes, fans out WS events to renderer over
  `agent-process:*` etc. The renderer's `WsTransportEmitter` (in
  cloud-linked Electron) becomes a thin shim that just proxies via IPC.
  Browser-mode `WsTransportEmitter` continues to own the WS itself (no
  Electron main process).
- `src/main/main-ws-client.test.ts`
- `src/server/ws-handler.reverse.test.ts` — reverse-RPC happy path, timeout,
  WS-drop mid-flight.

**Tests added**: as above.
**Bicep**: none.
**Docs**: update `CLAUDE.md` "Transport abstraction" section to describe
reverse-RPC.
**Dependencies**: Phase 1 (machine registry decides which WS to invoke
against).
**Effort**: 2 days. The protocol extension is small; consolidating the WS
into main is most of the work.

### Phase 3 — `RemoteElectronComputeClient` and compute dispatch (4 days)

**Goal**: Cloud's `ProcessManager` can dispatch sandbox lifecycle to a
named machine. End-to-end: pick `local:eric-mac` in the picker, the session
starts on the laptop's local Electron, the renderer sees `running` status,
sandbox WS resolves correctly.

**Files to create**:

- `src/main/remote-electron-compute-client.ts` — implements `IComputeClient`.
  Holds a ref to the cloud's `WsHandler` and a `machineId`. Each method
  (`startSession`, `waitForSession`, `stopSession`, `finalizeWorkspace`)
  translates to a `wsHandler.invokeOnSession(targetWs, 'compute:start-session', ...)`
  reverse RPC. Returns a `PlatformSession`-shaped object whose
  `websocketUrl` is the cloud-rewritten URL (see proxy work below).
- `src/main/remote-electron-compute-client.test.ts` — mocked WS reverse-invoke;
  verifies start, stop, status round-trip; capacity error path; offline error
  path.
- `src/main/compute-reverse-handlers.ts` — the Electron side: registers
  `compute:start-session`, `compute:stop-session`, `compute:get-status`,
  `compute:adopt-session`, `compute:pause`, `compute:unpause`,
  `compute:notify-activity`, `compute:resize-pty`, `compute:switch-sandbox`
  as reverse handlers. Each translates the reverse-call into a call against
  the local `ProcessManager`. Enforces capacity limit (default 5, env
  `OMNI_LOCAL_COMPUTE_MAX_SESSIONS`). Maintains the per-process `processId`
  mapping (the cloud uses `sessionId`; the local `ProcessManager` uses
  `processId` — they're the same string here, the cloud's session id is the
  local processId).
- `src/main/compute-reverse-handlers.test.ts`

**Files to modify**:

- `src/main/platform-client.ts` — add
  `MachineLocation = 'cloud' | { kind: 'local'; machineId: string }` (or just
  keep `IComputeClient` as-is and select the right impl in PM construction).
  Cleaner: leave `IComputeClient` unchanged and treat
  `RemoteElectronComputeClient` as just another impl.
- `src/main/process-manager.ts` — extend so a single PM can have _multiple_
  compute clients keyed by machine location, not just one `platformClient`.
  Replace `platformClient: IComputeClient | null` with
  `computeClients: Map<string, IComputeClient>` and a method
  `resolveComputeClient(profileName): IComputeClient | null` that returns
  the right one for a profile name like `local:eric-mac`. Cloud-ACI profiles
  (`aci`, `aci-desktop`) resolve to "no compute client — spawn omni serve
  locally"; local-machine profiles (`local:<machineId>`) resolve to
  `RemoteElectronComputeClient`; the legacy `platform` profile resolves to
  `PlatformClient`.
- `src/main/agent-process.ts` — generalize the `'platform'` mode branch.
  Today it's `mode: 'serve' | 'platform'`. We need
  `mode: 'serve' | 'compute'` where `compute` covers both `platform` and
  `local` (any `IComputeClient`-backed start). Keep `'platform'` as an alias
  for back-compat but the branch is now generic. The `startPlatformSession`
  body becomes `startComputeSession(arg, client)` and accepts any
  `IComputeClient`.
- `src/server/proxy-rewriter.ts` — extend `rewriteStatusUrls`: when the URL
  points to a known machine's local network (we'll wire this — see below),
  rewrite to either `/proxy/local/<machineId>/<sessionId>/<originalPath>`
  (cross-device) or leave as direct-LAN (when the request came from the same
  machine's renderer — detected via `request.socket.remoteAddress` matching
  the machine's WS's remoteAddress).
- Add a new route in `setupProxyRewriter`:
  `/proxy/local/:machineId/:sessionId/*` that: (a) looks up the machine in
  the registry; (b) sends a reverse-RPC `compute:proxy-tunnel-open` to that
  machine asking for a one-shot direct WS URL OR proxies the HTTP/WS request
  via the WS tunnel. For v1, simplest: register a per-session "tunnel proxy
  URL" on demand and proxy bytes through the existing reverse-RPC channel
  using a binary frame type. This is the bit of cloud relay needed for
  cross-device access to a local-anchored sandbox WS.

**More files to create**:

- `src/server/local-tunnel-proxy.ts` — implements
  `/proxy/local/:machineId/:sessionId/*`. For HTTP: opens a reverse-tunnel
  request via `MachineRegistry`
  (`compute:tunnel-http {path, method, headers, body}` → response). For WS:
  registers a `tunnel-frame` reverse channel that pipes WS frames
  bidirectionally. Uses a frame-id namespace per WS to multiplex multiple
  tunnels on the single cloud↔laptop WS.
- `src/server/local-tunnel-proxy.test.ts`
- `src/main/tunnel-handler.ts` — Electron side of the tunnel: receives
  `compute:tunnel-http` reverse calls, proxies to `127.0.0.1:<port>` of the
  local omni-serve, returns response. Also handles
  `compute:tunnel-ws-open / write / close` for WS frames.
- `src/main/tunnel-handler.test.ts`
- `src/main/aci-profile.ts` — unchanged. Add `getAvailableProfileNames`
  extension in `profile-list.ts` to include `local:<machineId>` entries when
  the cloud's snapshot includes `availableSandboxProfiles` with those
  entries.
- Update `src/renderer/features/SandboxProfile/profile-list.ts` — handle
  `local:<machineId>` shape, display "Local · Eric-MacBook (●)" with online
  indicator; resolve label from the machine list (`StoreData.machines`).
- Update `src/server/managers.ts` — in `getStoreSnapshot`, when machines
  exist for the principal, append `local:<machineId>` entries to
  `availableSandboxProfiles` so the picker can show them. Also:
  `getProcessManager` now constructs a PM whose `computeClients` map
  includes a `RemoteElectronComputeClient` per known machine.

**Key contract: `IComputeClient` for the local case**

```ts
class RemoteElectronComputeClient implements IComputeClient {
  constructor(
    private wsHandler: WsHandler,
    private machineId: string,
    private registry: MachineRegistry,
  ) {}

  async startSession(agentSlug, domain, gitRepo) {
    const ws = this.registry.getActiveWs(this.machineId);
    if (!ws) throw new ComputeError('host-offline', this.machineId);
    return this.wsHandler.invokeOnSession(ws, 'compute:start-session', {
      sessionId: <pre-allocated by cloud>,
      profileName: 'host' | 'devbox',  // local profile; cloud strips local:<id> prefix
      sources: [...],
      env: { ...materializedEnv },  // see Q2: cloud ships materialized env
      snapshotDir: <laptop local path>,
    });
  }
  // ... etc
}
```

**Tests added**: as above. Critical integration test:
`src/main/local-compute-integration.test.ts` that wires up a mock laptop
Electron + a cloud `WsHandler` in one process and verifies start → status →
sandbox-ws-reachable through `/proxy/local/...`.

**Bicep**: none yet.
**Docs**: `infra/DEPLOY.md` — add "Local compute mode" section.
**Dependencies**: Phase 1, Phase 2.
**Effort**: 4 days. The tunnel proxy is the load-bearing complexity.

### Phase 4 — UX: picker, status, banners (2 days)

**Goal**: User selects laptop in picker, gets clear feedback on host
status, sees correct banners.

**Files to modify**:

- `src/renderer/features/SandboxProfile/SandboxPicker.tsx` — group items:
  "Cloud" (aci, aci-desktop), "My computers" (local:<id> per machine), with
  online dots.
- `src/renderer/features/SandboxProfile/profile-list.ts` — extend
  `getProfileMenuLabel` to look up machine labels for `local:*` profiles.
  Add `MachineState` context param.
- `src/renderer/features/Banner/` — add a new banner kind `'host-offline'`
  that surfaces when a current session's host is offline (with
  `machineLabel`). Render in the chat / code-tab area.
- `src/shared/types.ts` — add `AgentProcessStatus` error variant
  `{ type: 'error', error: { kind: 'host-offline' | 'machine-at-capacity' | 'message', message: string, machineId?: string, machineLabel?: string } }`.
  Update consumers.
- `src/renderer/features/Chat/Chat.tsx` and `CodeTabContent.tsx` — render
  the new banner state when status carries `kind: 'host-offline'`.

**Files to create**:

- `src/renderer/features/SandboxProfile/MachineGroup.tsx` — sub-component
  for the picker.
- `src/renderer/features/SettingsModal/MachinesCard.test.tsx`

**Tests added**: picker rendering, banner display, machine label resolution.
**Bicep**: none.
**Docs**: README "Cloud-linked Electron" section gets a screenshot + bullet.
**Dependencies**: Phase 3.
**Effort**: 2 days.

### Phase 5 — Promote-to-cloud (3 days)

**Goal**: User on a local-anchored session clicks "Promote to cloud",
session migrates to ACI, chat continues seamlessly.

**Files to create**:

- `src/main/session-migration.ts` — orchestrator. Inputs: `sessionId`,
  `targetProfile: 'aci' | 'aci-desktop'`. Flow:
  1. Cloud sends `compute:snapshot-and-upload` reverse RPC to laptop →
     laptop calls existing `getSnapshotStore().push()` against an SAS URL
     the cloud minted.
  2. Cloud `ProcessManager.stop(sessionId)` on the laptop (reverse RPC).
  3. Cloud `ProcessManager.start(newSessionId, {sourceSessionId, restoreFromSnapshot: true})`
     on ACI.
  4. Cloud updates the session-to-tab mapping so the renderer's chat tab
     points at `newSessionId`.
- `src/main/session-migration.test.ts`
- `src/renderer/features/SandboxProfile/PromoteToCloud.tsx`

**Files to modify**:

- `src/renderer/features/Chat/Chat.tsx` — add menu item "Promote session to
  cloud" when `compute_location` is `local:*`.
- `src/shared/types.ts` —
  `IpcEvents['session:promote-to-cloud']: (sessionId, targetProfile) => Promise<{newSessionId: string}>`.
- Cloud `ProcessManager` — track `compute_location` per session (was implicit
  before).

**Tests added**: end-to-end mocked migration test.
**Bicep**: none (uses existing Blob container).
**Docs**: README + DEPLOY.md.
**Dependencies**: Phase 3.
**Effort**: 3 days.

### Phase 6 — Stale-session adoption + reconnect (2 days)

**Goal**: Laptop reconnects after sleep → existing sessions resume without
restart; cloud picks them back up.

**Files to modify**:

- `src/main/compute-reverse-handlers.ts` — implement
  `compute:adopt-session` reverse handler. On register, the cloud queries
  the laptop with `compute:list-sessions` → laptop returns currently-running
  sessionIds. For each that the cloud also knows about as `disconnected`,
  cloud calls `compute:adopt-session(sessionId)` → laptop returns the
  current `AgentProcessData`. Cloud transitions status from `disconnected`
  → `running`.
- `src/server/machine-registry.ts` — on `bindFromWs`, trigger adoption flow
  asynchronously: pulls list of sessions, drives the cloud `ProcessManager`
  to refresh each.
- `src/main/main-ws-client.ts` — reconnect logic must re-register the
  machine.

**Tests added**: `src/server/machine-registry.adoption.test.ts`.
**Bicep**: none.
**Docs**: none.
**Dependencies**: Phase 3, Phase 4 (for status surface).
**Effort**: 2 days.

### Phase 7 — Hardening + observability (2 days)

**Goal**: Logs, metrics, edge cases.

**Files to modify**:

- Add structured logs through `SimpleLogger` for: machine register/unregister,
  reverse-RPC dispatch (channel, latency), tunnel-proxy throughput, session
  compute-location transitions.
- `src/main/process-manager.ts` — `getStatus` exposes `computeLocation`
  (`cloud | local:<machineId>`).
- Tests for: (a) two Electrons same machine race (Q4), (b) capacity limit
  (Q12), (c) reverse-RPC timeout, (d) machine removed while session is
  running.

**Bicep**: none.
**Docs**: troubleshooting section in DEPLOY.md.
**Dependencies**: all prior phases.
**Effort**: 2 days.

## Total: 18 calendar days, one engineer

## Risk register

| Risk                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reverse-RPC adds a new failure mode (cloud reachable but laptop WS hung).** Cloud waits 30s on every `start`, user-visible latency. | Heartbeat ping on the cloud↔laptop WS every 10s; mark machine offline after 2 missed pings (~20s) BEFORE attempting a reverse-RPC, surface "host offline" instantly.                                                                                                                                                                                                                                                                                                                                                                                                       |
| **WS multiplexing under load (tunnel + control + per-session WS frames on one socket) creates head-of-line blocking.**                | Use `ws`'s built-in `binaryType` + small message frames; cap per-tunnel buffer; if a single tunnel saturates we fall back to direct WS connections via `compute:tunnel-direct-url` (laptop opens an inbound port and the cloud relays via that). Tracked as a v2 follow-up; for v1 the tunnel is fine for typical chat/terminal traffic.                                                                                                                                                                                                                                   |
| **Settings drift between laptop's standalone-Electron settings and cloud-shipped env.**                                               | Cloud-linked Electron's standalone-Electron settings are _invisible_ in cloud-linked mode (existing pattern — see `cloudMode` check in many places). Local-compute spawns use the cloud-shipped env exclusively. Documented in the Settings card.                                                                                                                                                                                                                                                                                                                          |
| **PG `machines` table grows unboundedly (every laptop the user ever signed in from).**                                                | Settings → Machines lists them with last-seen; user can remove. Auto-cleanup after 180 days untouched (cron in Phase 7, low priority).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Cross-machine token leak: cloud sends materialized env (Codex JSON, model keys) to laptop. If laptop is compromised, those leak.**  | This is the user's own laptop; they already trust it with the cloud WS. The materialized env is no different from what cloud-ACI sees today. Document explicitly in DEPLOY.md and the Settings card: "Local compute means your laptop holds your model keys for the duration of the session, materialized to a scratch dir under `~/.omni/cloud-sessions/`."                                                                                                                                                                                                               |
| **Existing per-PM single `platformClient` field is widely consumed.**                                                                 | The PM refactor to `computeClients: Map` is the breaking-API change with the widest blast radius. Mitigate: keep `platformClient` as a derived getter (`computeClients.get('platform') ?? null`) for the transition; remove in a follow-up.                                                                                                                                                                                                                                                                                                                                |
| **Renderer can't reach LAN IP of laptop when running on a phone over LTE.**                                                           | Always-relay path (`/proxy/local/...`) handles this. The LAN-direct optimization is opportunistic — when same-network, fast; when not, the relay path is the floor.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Snapshot tar is large; promote-to-cloud takes minutes.**                                                                            | Stream the upload (use SAS Block Blob `uploadStream`), show progress in the UI banner. If it fails mid-stream, the old laptop session is intact (we don't stop until upload succeeds).                                                                                                                                                                                                                                                                                                                                                                                     |
| **The WS-into-main consolidation (Phase 2) touches every renderer transport call.**                                                   | Behind a feature flag during dev (`OMNI_MAIN_WS=1`); cut over once the WS-handler.reverse.test passes; remove the flag in the same PR.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`MachineRegistry` is an in-process map; cloud has multiple replicas.**                                                              | First version pins machines to the replica they connect to; reverse-RPCs that arrive at the wrong replica reply `wrong-replica`, the cloud's `ProcessManager` re-resolves. If a session was started on replica A and replica B handles the next invoke, replica B looks up the machine in PG, finds no active WS locally, returns `host-offline`. Renderer shows the banner; the user's next WS reconnect lands on a replica that has the machine. Acceptable for v1 (most cloud deployments are single-replica). PG-NOTIFY-based cross-replica routing is a v2 follow-up. |

## Ship gates

**Phase 1 done when**: Cloud `machines` table populated; cloud-linked
Electron auto-registers on boot; Settings → Machines lists at least the
local machine; remove-machine round-trips to PG.

**Phase 2 done when**: A vitest integration test invokes a reverse-RPC from
cloud WsHandler → mock Electron and gets a response; timeout case works;
main-process owns the cloud WS in cloud-linked Electron.

**Phase 3 done when**: Pick `local:<id>` in picker, session starts on the
laptop, renderer's chat WS opens against the laptop's omni-serve (verified
via process listing — only the laptop has an `omni serve` running for that
sessionId), tearing down the session stops the laptop process. Cross-device
access (phone browser) reaches the same session via `/proxy/local/...`
relay.

**Phase 4 done when**: Stopping the laptop's WS shows "host offline" banner
on the renderer within 30s; restarting shows session resume.

**Phase 5 done when**: Promote-to-cloud takes a laptop session and produces
an ACI session whose first agent message references the laptop session's
last reply (proof of session-history continuity).

**Phase 6 done when**: Laptop sleeps for 5 minutes, wakes, the renderer's
session goes `disconnected` → `running` without restarting `omni serve`
(verified by container id parity).

**Phase 7 done when**: Logs include `machineId`, `sessionId`,
`computeLocation` on every relevant event;
`OMNI_LOCAL_COMPUTE_MAX_SESSIONS=1` hits the cap on the second start with
the documented error.

## Out of scope (for v1)

- **Cross-machine workspace migration** (`local:macA` → `local:macB`). Stop
  - start fresh; if user wants files moved, they git-push or use Promote-to-cloud
    as intermediate. Reason: no clean UX for "shipping ~5GB across user's
    two devices over WAN," would need its own design.
- **Cloud → laptop migration** (cloud-ACI to local). The reverse of Promote.
  Reason: solves a niche problem (user changed their mind mid-session);
  user can stop + start fresh; not enough demand to justify another snapshot
  transport.
- **Direct-LAN WS optimization when renderer ≠ same machine but is on same
  LAN**. We always use cloud-relay when the renderer didn't dial from the
  same outgoing IP as the laptop. Detecting "same LAN" reliably (NAT, IPv6,
  mobile hotspots) is a rabbit hole.
- **Per-tab compute location** (today: a chat tab + a code tab in the same
  project can pick different sandbox profiles, which is fine). v1 keeps
  that property: `local:<id>` is just another profile name, picked per-tab.
- **Web SPA "register this browser as a compute host"**. Compute hosts must
  be Electron — they need to spawn a local omni-serve, which a browser
  can't do. We don't surface any UI suggesting otherwise.
- **Machine approval flow (admin-style "approve this new machine")**.
  Implicit-trust-on-first-connect is the current design (matches how
  `cloudMode` works today — connecting itself is the authentication). If
  user concern arises, an "Approve" step can be retrofitted as a
  pending-machines list.
- **Quotas/billing per machine.** Local compute is the user's own resources;
  cloud doesn't bill it.
- **Snapshot transport caching, encryption at rest on the laptop snapshot
  dir.** Snapshot dir is on the user's machine; we don't add a new
  encryption layer.

## First commit (smallest risk-reducer)

**Add the `machines` PG schema + a one-shot `cloud:get-machine-identity`
IPC + render the local Electron's machineId/label as a read-only chip in
the Settings → Cloud card.** No reverse-RPC, no compute dispatch, no
profile-list changes. This commit:

- Lands the migration (the single highest-blast-radius change).
- Proves the identity-generation + persistence path works on
  Mac/Windows/Linux.
- Surfaces the user-visible label so we can confirm it's reasonable across
  platforms (`os.hostname()` returns surprisingly varied things).
- Adds zero new code paths to `ProcessManager` or `WsHandler`, so it's a
  trivial review.
- Lets us validate the principal_id RLS policy in production before any
  feature depends on it.

Files in this first commit:

- `packages/projects-db/src/pg/schema.ts` — migration v10
- `packages/projects-db/src/pg/machines.ts` + test
- `src/main/machine-identity.ts` + test
- `src/main/index.ts` — wire `cloud:get-machine-identity` IPC
- `src/renderer/features/SettingsModal/MachineIdentityChip.tsx`

After this lands and bakes for a couple of days, Phase 1 finishes by wiring
auto-register over the existing WS and listing the cloud's view of all
machines.

## Critical files for implementation

- `src/main/process-manager.ts`
- `src/main/platform-client.ts`
- `src/server/ws-handler.ts`
- `src/server/managers.ts`
- `src/main/agent-process.ts`
