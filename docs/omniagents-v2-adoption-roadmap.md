# Omniagents v2 Adoption Roadmap

## Purpose

Omni Desktop has substantially adopted Omniagents Serve Protocol v2, including targetless AgentHost startup, workspace and profile registration, environment materialization, thread binding, explicit environment routing, generated GUI protocol artifacts, filesystem and Git RPCs, authentication tickets, and durable event replay.

The remaining work should be completed as a staged migration rather than by wiring every new RPC into existing screens. Three correctness foundations come first:

1. Route the complete execution target, including environment generation.
2. Make RPC lifecycle and replay conform exactly to Omniagents.
3. Establish a principal-scoped management plane and explicit configuration ownership.

This document describes the target architecture, implementation phases, merge order, and definition of done.

## Implementation Status (2026-08-06)

Implemented in the current Omni Desktop worktree:

- Strict installed-runtime v2 preflight and source-schema verification.
- Complete generation-aware `ExecutionTarget` propagation through agent, terminal, filesystem, Git, and run routing.
- Canonical lifecycle defaults, whole-attempt connect deadlines, per-call timeout/abort support, permanent close classification, and replay-before-ready reconnects.
- Cursorless session registration, `-32030` quarantine, authoritative resync completion, and acknowledgement failure recovery.
- AgentHost resource reconciliation, reconnect adoption, generation-aware stale-target protection, and start/stop/cleanup race serialization.
- Runtime-validating clients for canonical conversations, conversation organization, structured elicitation, models/providers, accounts, MCP, layered config, plans/run diffs, and AgentHost management.
- Canonical paginated conversation loading with revision-aware item merging and a one-release legacy fallback restricted to unsupported-method/protocol errors.
- Live structured-elicitation queue and shadcn-based question, confirmation, selection, flat form, and URL handoff UI.
- Permanent connection/protocol failures surfaced as a terminal, retryable UI state.
- Snapshot upload verification, retained retry bookkeeping, bounded in-memory retry, stop reconciliation, and forced/uncertain shutdown reporting to the user.
- A permission-restricted durable snapshot retry ledger, Electron/server startup reconciliation, forced-uncertain quarantine, and garbage-collection protection across restarts.
- A product-scoped targetless management connection and repository that work without an open code column and refetch non-journaled model, provider, account, MCP, and layered-config state after reconnect.
- Settings and ChatGPT onboarding read canonical runtime model/provider/account state first, with legacy reads retained only when the management runtime is unavailable; launcher-owned persistence and privileged mutations remain in their existing owners.
- Plugins use canonical Omniagents MCP CRUD, status, and OAuth state after the local Electron ownership transfer; migration parity, write-only secret handling, the managed `omni-projects` read-only connector, and legacy-writer shutdown are covered. Server/multi-user and marketplace-owned definitions remain Desktop-owned.
- A closed main/server-process admin broker for config validation/write, account lifecycle, and MCP CRUD/auth mutations; request methods are allowlisted, strict protocol decoders are reused, and control credentials never cross into renderer code.
- Generation-aware Git operations and UI for commit/amend, history, branches, worktrees, checkout/create, reset, fetch/pull/push, progress, confirmations, and conflict resolution.
- A strict platform compute-session contract carrying AgentHost/workspace/environment/generation routing, safe service URLs, and ordinary consumer credentials without renderer token leakage.
- Canonical `list_threads` as the sidebar/recent-session source of truth, with a one-release unsupported-operation fallback and live `thread_updated` refresh.
- Capability manifests now negotiate conversation organization and plans/run diffs atomically, including their required non-journaled notifications; partially negotiated surfaces stay hidden.
- Capability-gated conversation search, rename, pin/unpin, and archive-with-undo UI, with stale-search suppression, reconnect refetch, and cross-column `thread_updated` convergence. Export, fork, and purge remain intentionally hidden until their product semantics are defined.
- Session-scoped model and reasoning controls backed by canonical catalog mutations, locked while a run is active.
- Authoritative `get_plan` and `get_run_diff` recovery on session load, reconnect, and run completion, plus live revision-aware `item_updated` projection into the existing AI Elements-based chat presentation. Legacy `tasks_snapshot` is now only an older-runtime fallback.
- MCP Apps resource reads and out-of-band tool calls use typed, negotiated `mcp_read_resource` and `mcp_call_tool` operations with runtime result validation; tool discovery alone retains `server_call` because no generated list-tools operation exists.
- A descriptor-driven Runtime Policy settings surface backed by canonical `get_config`, brokered `validate_config`/`write_config`, provenance and read-only metadata, write-only secret handling, atomic validation, GUI-overlay reset, reload-impact badges, and authoritative refresh.
- Local AgentHost startup, rebuild, and product-management attachment now wait for the entire runtime install transaction, including the development editable Omniagents overlay. This removes the transient window where `.venv/bin/omni` existed while `omniagents.product_cli` was temporarily unavailable.
- The released, locally built, and freshly downloaded Omniagents wheels were verified to contain and import `omniagents.product_cli` and `omniagents.product_serve`; an Omniagents wheel-content regression test now protects that launcher-facing contract.
- A launcher-preallocated session with no recorder rows yet treats canonical `thread_not_found` as an authoritative empty transcript. Other canonical, protocol, and server failures remain fatal.
- The privileged AgentHost control connection now reports its runtime-validated mutation capabilities as booleans beside the ordinary management connection; no control credential or generic admin transport crosses IPC. Runtime Policy write affordances use this broker capability boundary rather than the read-only renderer connection.
- Omniagents authorization now permits admin-role principals to invoke the explicitly classified process-wide mutation set while continuing to deny ordinary authenticated principals. This makes the control-token admin broker effective for config, account, and MCP mutations without widening the renderer surface.
- Omniagents now exposes a redacted, fail-closed Codex OAuth persistence capability. Only an exact host attestation reports that the product-scoped `codex.json` survives AgentHost replacement; pending OAuth, API-key credentials, and provider selection remain explicitly process-only.
- Local Electron transfers an existing Codex account to Omniagents in place after canonical/legacy state parity and durable-host attestation. No credential bytes are copied or deleted during migration; after the ownership marker is written, login/logout mutations must use the canonical account RPCs and legacy file mutation fails closed.
- The account admin broker now requires both the runtime durability attestation and an Electron-only topology gate. It permits only the Codex OAuth mutation subset, denies API-key accounts and `account_select`, and remains disabled for server/multi-user ProcessManagers even if child environment variables are spoofed.
- Permanent Playwright stories cover canonical session identity, live session model/reasoning controls, Runtime Policy inspection/write/reset, and real Git stage/commit/history behavior. Focused Electron visual proof for model/reasoning controls and Runtime Policy passes against clean isolated runtimes.
- Permanent Electron Playwright coverage proves a pre-existing local Codex credential is recognized canonically, removed by brokered logout, and does not resurrect after a full application restart.
- Omniagents exposes a redacted, fail-closed MCP persistence capability with host durability, managed-server ownership, process-only pending OAuth state, and admin-only mutation authorization.
- Local Electron transfers MCP definitions and OAuth state after exact redacted parity and durable-host attestation; canonical CRUD reloads every active local AgentHost and fails closed on stale-peer invalidation.
- Permanent Electron Playwright coverage proves MCP migration, managed-server protection, write-only secret preservation, canonical create/update/delete, restart persistence, and no resurrection after deletion.
- `agent_host_bind_thread` existing selections now carry an optional `environment_generation`; Omniagents pins it in the binding, fails closed at bind validation and inherit-mode run resolution when the environment was rebuilt, and the launcher sends its materialized generation at every bind.
- `agent_host_list_resources` additionally returns owner-attributed `profiles_by_owner` filtered by the standard ownership rule, so an admin/control principal can authoritatively inspect token-user profile definitions.
- Generated TypeScript now renders nullable request strings as `string | null`, so `update_thread.title: null` (clear title) is expressible end to end.

Remaining product-level migrations:

- Keep server/multi-user Codex mutations on their existing per-principal secret-store path until that backend exposes an equivalent durability capability and passes login-survives-restart/logout-does-not-resurrect coverage. The local Electron capability must never be inferred for those deployments.
- Keep custom provider/model definitions, marketplace MCP definitions and secrets, raw environment variables, and network policy Desktop-owned until equivalent Omniagents persistence and invalidation semantics exist. The current runtime catalog/account/MCP/config reads are not interchangeable with those writers.
- Remove the one-release legacy conversation and account-status fallbacks only after the supported runtime floor guarantees the corresponding v2 capabilities.
- Add a semantic snapshot checksum if Omniagents exposes one.

Platform backend migration is intentionally outside this Desktop adoption plan.

### Validation Snapshot (2026-08-06)

- Launcher unit/integration suite: 206 files passed, 2 skipped; 2,450 tests passed, 11 skipped; no type errors.
- Launcher TypeScript check, production build, Prettier/diff checks, generated protocol check, and source verification passed. The verified GUI schema is `1.0.0` at Omniagents commit `a2b77920daf75be63dc2725c85175fa4b5ca8f7d`.
- Omniagents focused config-authorization and distribution tests: 15 passed. The distribution test builds the real wheel and imports `product_cli` and `product_serve` from it.
- Combined Electron visual proof: 2 passed in 51.4 seconds. It performs a clean editable runtime install, confirms install completion precedes `omni serve`, changes the active session model/reasoning, renders real config descriptors/provenance, validates and writes an isolated override, refetches, and resets to the inherited value.
- Local account durability validation: 44 focused Omniagents tests passed, including fail-closed attestation, redaction, login/logout restart behavior, and ordinary-principal denial/admin allowance. Launcher account-owner, broker, and AgentProcess focused tests passed with no TypeScript errors.
- Electron account-cutover proof passed against an isolated `0600` credential: canonical signed-in state, brokered logout, physical token removal, full Electron restart, and durable signed-out state with no resurrection.
- Proof report: `artifacts/playwright-proof-report/index.html`.
- Latest proof results: `artifacts/playwright-proof-results/codex-account-cutover-Chat-39314--across-an-Electron-restart-electron-local/`.
- MCP ownership validation: 34 focused Omniagents tests and 33 focused launcher tests passed; TypeScript, production build, protocol verification, formatting, and diff checks passed.
- MCP visual proof passed for migration/protected managed state and canonical create/update/delete/restart behavior. Results are under `artifacts/playwright-proof-results/mcp-config-cutover-*`.

Known upstream protocol gaps discovered during implementation (three closed 2026-08-06):

- CLOSED: `agent_host_bind_thread` now carries an optional `environment_generation`; bindings pin it and stale generations fail closed at bind and inherit-mode run resolution.
- CLOSED: `agent_host_list_resources` now returns owner-attributed `profiles_by_owner`, making token-user profile definitions inspectable by an admin principal.
- CLOSED: generated TypeScript now types nullable request strings as `string | null`, so `update_thread.title: null` is expressible.
- AgentHost resource inventory omits enough runtime detail to reconstruct every lost materialization response without a guarded idempotent materialize.
- Thread updates have no revision beyond `updated_at` ordering.
- No generated agent-list, agent-type, or plugin-management RPCs exist.
- Object-valued result schemas remain open `Record<string, unknown>` in generated TypeScript, so Desktop validates them at each RPC boundary.

## Target Connection Architecture

| Connection                | Credential                   | Responsibilities                                                                                                                 |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Per-column RPC client     | Ordinary user token          | Runs, canonical transcript, approvals, elicitation responses, session model selection, filesystem, and Git                       |
| Management RPC client     | Ordinary user token          | Thread listings and search, model/provider catalog, account status and usage, MCP status, and non-journaled subscriptions        |
| Main-process admin broker | Control/admin token          | AgentHost provisioning and process-wide mutations: config writes, account login/logout, MCP CRUD/OAuth, voice default, and purge |
| Platform backend          | Never expose the admin token | Remote workspace/environment materialization and consumer-scoped runtime credentials                                             |

The existing `AgentHostControlClient` is the beginning of the admin broker. Its privileged token must remain main/server-process only and must never be exposed to the renderer.

## Phase 0: Correctness Foundations

### 0.1 Introduce One Complete `ExecutionTarget`

Desktop currently preserves `workspaceId` and `environmentId`, but drops the environment `generation` returned by materialization. That bypasses Omniagents' stale-generation protection.

Create a shared value:

```ts
type ExecutionTarget = {
  workspaceId: string;
  environmentId: string;
  environmentGeneration: number;
};
```

Route it through:

- Process and runtime status.
- `start_run.environment_selection`.
- `server_call`.
- Every `fs_*` and `git_*` request.
- Terminal creation and attachment.
- Filesystem and Git event filtering.
- Pause/unpause and environment lifecycle operations.

Primary files:

- `src/main/agent-process.ts`
- `src/shared/types.ts`
- `src/renderer/omniagents-ui/rpc/client.ts`
- `src/renderer/omniagents-ui/rpc/fs.ts`
- `src/renderer/omniagents-ui/rpc/git.ts`
- `src/main/terminal-proxy.ts`

This is the highest-priority Serve Protocol v2 correctness fix.

### 0.2 Conform the RPC Lifecycle

Desktop already has the correct upstream policy in `src/shared/lifecycle.ts`, but the active state machine duplicates different constants.

Change the main client to use:

- A 10-second whole connection attempt covering ticket exchange, WebSocket open, and initialization.
- A 60-second default RPC timeout.
- Per-call timeout overrides or disabled timeouts for known long calls.
- `AbortSignal` cancellation.
- A 20-second ping interval and 10-second pong timeout on the server.
- Reconnect backoff of `0.5s × 2`, ±10% jitter, a 30-second cap, and 10 attempts.
- Permanent close classification for `4401`, `4403`, `4404`, `1002`, `1003`, and `1008`.
- Structured connection-closed errors containing close code, reason, and permanence.
- A terminal closed/auth-failed state with explicit retry or reauthentication UI.

Do not automatically retry ambiguous mutations such as `start_run`, queue writes, Git mutations, or `server_call` after losing their responses.

Apply the same policy to realtime connections. Terminal connections should either explicitly recreate their session or clearly declare themselves non-resumable.

Primary files:

- `src/shared/lifecycle.ts`
- `src/shared/machines/rpc-client.machine.ts`
- `src/renderer/omniagents-ui/rpc/client.ts`
- `src/renderer/omniagents-ui/rpc-context.tsx`
- `src/renderer/omniagents-ui/rpc/realtime.ts`
- `src/shared/machines/chat-boot.machine.ts`
- `src/renderer/omniagents-ui/hooks/use-chat-boot.ts`
- `omniagents/omniagents/product_serve.py`

### 0.3 Finish Replay Recovery

Current replay support is strong but has several edge cases:

- A selected session that has never emitted a sequenced event is not reattached after reconnect.
- The client becomes connected before replay restoration completes.
- `ack_events` returning `-32030` is silently swallowed.
- A transient disconnect during `resume_session` can be misclassified as a full resync.
- A tracker can remain cursorless after authoritative resync.

Add:

- `registerSession` and `unregisterSession`.
- Cursorless reconnect through `resume_session { after_seq: 0 }`.
- A `restoring` readiness phase.
- Typed resync metadata and `completeResync`.
- Canonical authoritative refetch after `-32030`.
- Correct handling of `ack_events -32030`.

Never send a nonzero replay cursor without its `stream_id`. Do not treat filtered notification sequence gaps as missing events; adopt the journal's returned `last_seq`.

Land execution targeting, lifecycle, and replay before canonical conversations, MCP management, or plans.

## Phase 1: AgentHost Recovery and Lifecycle

### 1.1 Consume `agent_host_list_resources`

Desktop negotiates this operation but does not use it. It should drive reconciliation after:

- Control-socket reconnect.
- AgentHost restart.
- Renderer reload.
- An ambiguous materialize or stop response.

Persist a desired-consumer record containing:

- Thread ID.
- Workspace ID and sources.
- Profile ID and definition.
- Snapshot reference.
- Expected environment ID and generation.

On reconciliation:

- For a matching ready environment, rebind the thread.
- For a stopped, failed, or missing environment, rematerialize it.
- For a mismatched host, workspace, or owner, fail closed and restart the host.
- Never blindly retry a non-idempotent stop or materialization after losing its response.

`agent_host_list_resources` does not report thread bindings, so an adopted environment must be rebound explicitly.

### 1.2 Fix Start/Stop/Cleanup Races

`stop()` or global cleanup can race a materialization that has not finished and leak the resulting environment.

Serialize lifecycle per consumer using an epoch or cancellation token:

- Stop invalidates and awaits a pending start.
- A late materialization result is immediately retired.
- Rebuild cannot publish a stale first result after newer intent wins.
- Cleanup awaits starts as well as stops.

Required fault-injection cases:

- Stop during materialization.
- Cleanup during materialization.
- A stale first start followed by changed intent.
- Control-socket loss during each provisioning phase.

### 1.3 Make Snapshot Durability Explicit

If the server commits `stop_environment` but the response socket drops, Desktop may currently skip blob upload.

Required behavior:

1. Reconnect to the AgentHost.
2. Inspect resources.
3. Determine whether the stop committed.
4. Upload the persisted snapshot when committed.
5. Retain retry bookkeeping until upload succeeds.
6. Report persistence as uncertain after forced `SIGKILL` rather than silently succeeding.

Host shutdown should report whether it was graceful or forced. Snapshot files should be verified before blob upload after pooled-host teardown.

### 1.4 Harden Local Readiness and Preflight

For a locally spawned host:

- Fail closed when `describe --json` is absent, malformed, timed out, or not protocol v2.
- Allow legacy behavior only behind an explicit legacy flag, if it remains necessary.
- Assert that readiness `auth_token` matches the locally generated client token.
- Validate that local `ws_url` and `ui_url` are expected loopback/same-origin endpoints.
- Continue redacting client and control credentials from logs.
- Fix `npm run protocol:verify-source`; its package script currently omits the required source-root argument.

## Phase 2: Management Runtime and Capability Registry

Create a product/principal-scoped management service that can exist without an open code column.

It should:

- Attach a synthetic management consumer to the pooled AgentHost.
- Be available during onboarding and Settings.
- Own model, account, MCP, and thread repositories.
- Subscribe once to `account_changed`, `mcp_server_status_changed`, and `thread_updated`.
- Refetch authoritative snapshots after reconnect because those events are not journaled.
- Expose typed hooks and repositories to UI components.
- Stay alive while Settings, onboarding, or conversation history requires it.

Replace the fixed `WORKSPACE_EXPERIMENTAL_OPERATIONS` list with feature manifests:

| Feature                   | Experimental operations and notifications                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Filesystem                | `fs_*`, `fs_events`, `fs_rescan_required`, `fs_transfer_progress`                                     |
| Git                       | `git_*`, `git_operation_progress`                                                                     |
| Conversation organization | `list_threads`, `search_threads`, `update_thread`, descendants, export, purge, fork, `thread_updated` |
| Plans and diffs           | `get_plan`, `get_run_diff`, `item_updated`                                                            |
| MCP operations            | `mcp_read_resource`, `mcp_call_tool`, `mcp_get_prompt`                                                |
| Layered config            | `get_config`, `validate_config`, `write_config`                                                       |

Only advertise experimental operations when their consumer and recovery path exist. Gate feature startup and UI from the negotiated result, not merely from what Desktop requested.

For results represented as `Record<string, unknown>`, follow the filesystem and Git precedent: decode and validate at the RPC boundary instead of scattering casts through components.

## Phase 3: Canonical Conversations

Build a typed `ConversationClient` for:

- `get_thread`
- `list_turns`
- `list_items`
- `get_item`

Use canonical `seq`, `item_id`, `turn_id`, `revision`, and lifecycle state. Do not flatten everything back into the current legacy history parser.

Migration approach:

1. Load canonical pages as the authoritative baseline.
2. Merge live notifications by canonical or natural identity.
3. Ignore stale revisions.
4. On `-32030`, reload canonical objects rather than raw history.
5. Keep a legacy history fallback for one compatibility release.
6. Remove `src/lib/rehydrate-history.ts` and `get_session_history` after parity is proven.

Each item kind should have an explicit adapter plus an unknown-kind fallback. Approvals, artifacts, MCP UI, reasoning, compaction, elicitations, plans, and run diffs must remain structured.

Acceptance criteria:

- Old pre-domain sessions lazily project and render identically after reopen.
- Long transcripts page without skipped or duplicated items while a run writes.
- Tool call and result collapse into one canonical item.
- Artifacts, MCP UI, approvals, attachments, and assistant-role wakeups survive refresh.
- Out-of-order or stale revisions cannot overwrite newer items.
- Disconnect/replay and forced `-32030` resync converge to the same transcript.

## Phase 4: Structured Elicitation

Land this before MCP management and OAuth because MCP `elicitation/create` uses the same lane.

Implement one session interaction queue for:

- Question.
- Confirmation.
- Selection.
- Form.
- URL handoff.

Keep elicitations separate from execution approvals.

Required behavior:

- Perform client-side schema validation while treating server validation as authoritative.
- Respond to unsupported schemas or kinds with `unsupported_by_client` rather than ignoring them.
- Treat the first response as authoritative.
- Treat duplicate/already-resolved errors as convergence rather than fatal UI errors.
- Remove prompts on `elicitation_resolved`, expiry, cancellation, or restart.
- Restore pending prompts through replay.
- Ensure non-persistent sensitive answers never enter transcript, search, or UI history.
- Reuse the same state for chat, voice, and attention indicators.

Acceptance criteria:

- All supported kinds submit correct value envelopes.
- Invalid forms remain answerable.
- Replay restores a pending elicitation.
- Expired, cancelled, and server-restart prompts disappear.
- Two tabs answering the same prompt converge.
- Unsupported schema auto-declines cleanly.
- Elicitation answers never become tool approvals.

## Phase 5: Conversation Organization and Branching

After canonical reads are authoritative, adopt:

- `list_threads`
- `search_threads`
- `update_thread`
- `list_thread_descendants`
- `fork_session`
- `export_thread`
- `purge_threads`
- `thread_updated`

Move server-owned title, pin, and archive state out of Desktop's duplicated conversation store. Keep Desktop-only metadata separate:

- Layout and tab state.
- Project and ticket association.
- Workspace and snapshot selection.
- Sandbox profile.

Before deleting Desktop's existing conversation index, prove how targetless multi-environment hosts expose every project/history shard. If `list_threads` remains shard-local, Desktop needs a multi-shard aggregation repository or Omniagents needs a global principal listing API.

Legacy migration must materialize old sessions into canonical threads before `list_threads` becomes authoritative.

Forking requires an explicit workspace rule: shared workspace, cloned snapshot, or worktree. Conversation branching alone must not silently create an unrelated empty workspace.

Acceptance criteria:

- Legacy history remains visible after upgrade.
- Pagination does not duplicate or omit threads.
- Rename, pin, or archive in one column updates other columns.
- Reconnect refetches current metadata.
- Search opens the matching item.
- A branch transcript is an exact prefix at the chosen turn or item.
- Parent and child cache entries do not collide.
- Archive and delete warnings accurately reflect descendants.
- Closed-project and cross-workspace conversations remain discoverable.

## Phase 6: Durable Plans and Run Diffs

### Plans

- Load through `get_plan`.
- Apply `item_updated` only when the revision increases.
- Replace legacy `tasks_snapshot` after parity.
- Preserve plan generations, dependencies, blockers, ownership, and terminal reasons.
- Keep Desktop's separate plan-approval interaction distinct from the durable agent plan.

### Run Diffs

- Load `get_run_diff` at run completion.
- Optionally apply live `item_updated` revisions to a changes view.
- Show per-turn changes linked to Files and Git.
- Render truncation, opaque/binary files, and unknown baselines honestly.
- Label the surface "agent file edits" because current run diffs may not observe shell-only filesystem changes.

Acceptance criteria:

- Plans survive refresh and restart and show earlier generations.
- Out-of-order `item_updated` notifications are ignored.
- Completed, blocked, failed, and cancelled steps render correctly.
- No-plan and no-diff are normal empty states.
- Diff statistics remain honest when content is truncated.
- Binary, large, or baseline-unknown files do not pretend to have text hunks.

## Phase 7: Models, Accounts, MCP, and Config Ownership

This phase requires an explicit source-of-truth decision for each data family.

Recommended ownership:

| Data                                  | Authority after migration                           |
| ------------------------------------- | --------------------------------------------------- |
| Desktop UI and team preferences       | Desktop store                                       |
| Custom provider and model definitions | Desktop until Omniagents exposes configuration CRUD |
| Runtime catalog and session selection | Omniagents model APIs                               |
| Account credentials and usage         | Omniagents account store and API                    |
| MCP server registry and OAuth secrets | Omniagents MCP API and config                       |
| Registered runtime policy fields      | Omniagents layered-config overlay                   |

Do not run two writers for the same file or domain. Desktop currently rematerializes `models.json` and `mcp.json`; calling mutating RPCs without a cutover would let later materialization overwrite those mutations.

### 7.1 Model Catalog and Per-Session Controls

Adopt read and session-scoped calls first:

- `list_models`
- `get_model`
- `list_providers`
- `set_session_model`
- `set_session_reasoning`

Use catalog metadata for:

- Availability and actionable failure reasons.
- Context and output limits.
- Reasoning choices and defaults.
- Modality and realtime filtering.
- Deprecation and replacement guidance.
- Provider health.

`set_voice_model` is process-wide and must go through the admin broker.

The catalog does not replace the custom provider-definition editor yet.

### 7.2 Account Cutover

After a one-time credential migration:

- Replace `codex:status`, `codex:link`, and `codex:logout` with `account_*` operations.
- Stop Desktop writing `codex.json`.
- Refetch account and model state after `account_changed`.
- Never persist returned or entered secrets in renderer state.
- Treat externally managed credentials as read-only.

Account mutations are process-wide in authenticated deployments and must use the admin broker under an isolated principal/config scope.

### 7.3 MCP Cutover

After migrating `mcpConfig`:

- Stop rematerializing `mcp.json`.
- Use MCP CRUD, status, and OAuth RPCs.
- Replace `server_call("mcp.read_resource")` and `server_call("mcp.call_tool")` with typed operations.
- Use `mcp_get_prompt` for prompt consumers.
- Preserve the managed `omni-projects` connector as managed/read-only configuration.
- Refetch server status after reconnect.

Because several AgentHosts may share one persistent config directory, the management broker must reload or invalidate all active hosts after mutation. Do not mutate one host while leaving other hosts with stale in-memory registries.

### 7.4 Layered Runtime Configuration

Use `get_config` descriptors to render runtime-policy fields dynamically.

Always:

1. Validate a batch.
2. Write it atomically.
3. Respect provenance and read-only reasons.
4. Distinguish hot, next-session, and restart-required changes.
5. Never reconstruct secret values from reads.

Layered config does not replace Desktop's own settings-layer system. It covers registered Omniagents runtime and project policy fields.

Process-wide mutations must use the admin broker only when the requesting principal owns an isolated host and config scope. In multi-user server mode, the admin credential must not become a bypass for arbitrary tenant mutations.

## Phase 8: Remaining Feature Completion

### 8.1 Complete the Git Product Surface

The typed Git client already implements operations not yet exposed in the Desktop UI. Add:

- Commit.
- History.
- Branch and worktree management.
- Checkout and reset.
- Fetch, pull, and push.
- Conflict-resolution workflows.

## Recommended Merge Order

1. Complete `ExecutionTarget`, including generation.
2. Lifecycle and structured connection errors.
3. Replay registration and resync correctness.
4. AgentHost lifecycle serialization and snapshot recovery.
5. `list_resources` reconciliation and strict protocol-v2 preflight.
6. Management connection, typed repositories, and capability manifests.
7. Canonical conversations.
8. Structured elicitation.
9. Conversation organization and branching.
10. Plans and run diffs.
11. Model catalog and per-session controls.
12. Layered config UI.
13. Local account cutover after durable account-store integration.
14. MCP ownership cutover after Desktop-owned definitions and secrets have a lossless migration.
15. Retire one-release compatibility fallbacks after raising the runtime floor.

## Non-Negotiable Migration Rules

- Serve Protocol v2 remains distinct from GUI protocol `1.0.0`.
- Preserve and route workspace ID, environment ID, and environment generation together.
- Never derive environment paths or identity from persisted session paths.
- Never send the admin control token to a renderer.
- Never automatically resend an ambiguous mutation after losing its response.
- Never send a nonzero replay cursor without its stream ID.
- Treat non-journaled notifications as snapshot invalidations and refetch after reconnect.
- Request experimental operations only when their handler and recovery path ship.
- Gate behavior from negotiated capabilities, not requested capabilities.
- Do not count generated types as feature adoption.
- Do not retain two writable sources of truth for the same domain.
- Do not round-trip or reconstruct write-only secrets.
- Keep Desktop-owned layout/project metadata separate from server-owned conversation metadata.
- Use runtime decoders for open-record RPC results.
- Unknown item kinds and additive fields must remain forward-compatible.

## Definition of Done for Every Slice

- No second writable source of truth remains for the migrated domain.
- Every experimental UI is capability-gated.
- Every notification family has a reconnect recovery strategy.
- Stale revisions and environment generations fail closed.
- Secrets never appear in renderer persistence, logs, URLs, replay, or read responses.
- Negative multi-user authorization is tested.
- Unit and integration coverage includes disconnects, lost responses, retries, and duplicate delivery.
- User-visible behavior has permanent Playwright coverage under `tests/e2e/specs/`.
- Coverage runs in both `server-local` and `electron-local` where applicable.
- Before review, generate and cite visual proof:

```bash
npm run test:e2e:proof:server
npm run test:e2e:proof:electron
```

Proof reports and results should be available under:

- `artifacts/playwright-proof-report/`
- `artifacts/playwright-proof-results/`

## Recommended Next Implementation Slice

The local Electron account ownership migration is complete. The next safe work is compatibility retirement and the persistence contract needed for the next ownership domain:

1. Keep server/multi-user account mutations disabled until the per-principal backend exposes an equivalent durability capability and passes login-survives-restart/logout-does-not-resurrect tests.
2. After one compatibility release on the v2 runtime floor, remove the local legacy account mutation/status paths and the legacy conversation-history fallback.
3. Before extending MCP ownership to server/multi-user or marketplace-managed definitions, define a lossless per-principal persistence contract plus cross-AgentHost reload/invalidation semantics; local Electron MCP ownership is complete.
4. Add a semantic snapshot checksum if Omniagents exposes one.

Custom provider/model definitions, marketplace MCP definitions/secrets, environment variables, and network policy remain Desktop-owned until their migrations are lossless and single-writer.
