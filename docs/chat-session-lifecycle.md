# Chat session lifecycle

## Ownership

Session state is no longer owned by a switchable chat component:

```text
Shared runtime connection (endpoint + credentials; reference-counted provider leases)
└─ SessionRegistry (one event router)
   ├─ ConversationSession A → subscribed views of A
   └─ ConversationSession B → subscribed views of B
```

Separate `RPCClientProvider` wrappers for the same endpoint and credentials share one client, management cache, and session registry. Closing one provider does not disconnect other views. Different endpoints, credentials, or injected client factories are never pooled together. The last provider lease releases the connection and session controllers; StrictMode's immediate cleanup/setup pair does not disconnect them.

Within that connection, the registry key is the session ID: two runtimes with the same session string do not share a controller. A controller's identity never changes. Selection subscribes to another controller; it does not retarget an actor. The App boundary also keys session views by connection and session, keeping transient layout state and host callbacks out of the next conversation.

Controllers own transcript actors, replay registration, hydration, serialized submission, slash-command results, client-function handling, pending escalations, and revisioned panel/settings state. Model controls subscribe to that session-owned state. View effects only publish host-specific notifications or manage presentation; they do not acknowledge session client calls or disconnect the shared connection.

Controllers remain alive when their views unmount, so an outstanding request for A still updates A while B is displayed. The provider disposes them when the connection owner goes away. Deferred disposal tolerates React StrictMode's cleanup/setup cycle. This is in-memory ownership, not persistence across an application restart.

The event router requires an explicit session/thread identity and rejects conflicting or missing identities. It never falls back to the selected chat. Client-tool fulfillment happens once per request on the owning controller; another session cannot acknowledge an offscreen escalation.

## Lifecycle rules

Conversation identity, connection readiness, and execution readiness are separate:

- A launcher conversation can own a draft and model choices before its workspace starts.
- `ConversationComposerProvider` keeps the same composer mounted while its DOM host moves from the startup shell to the live conversation. Selection, focus, and local input history survive that transition.
- `conversation-drafts.ts` owns unsent text, File objects, pre-launch choices, and outstanding submission identity by conversation ID. IndexedDB persists them in the current origin/profile, including attachment bytes. A component unmount or renderer restart is not a draft deletion. Storage failures preserve the in-memory draft and display an error; clearing app/browser storage still deletes local drafts.
- The product management catalog supplies pre-launch models. Controller hydration applies explicit choices through `prepareConversation` before becoming ready. Refused choices block the first prompt and remain available for retry.
- Hydration coalesces concurrent reads, registers replay, loads history and queue contents, and restores active-run state atomically. There is no intermediate ready/idle state before an active run is restored. The client explicitly negotiates `queue_status`; failure to discover run state is an initialization error, not an assumption that the session is idle.
- `queue_status(include_snapshot=true)` returns canonical history, queue, pending client requests, run state, and the journal watermark without yielding the runtime's session-owning event loop. The client fences older replay requests during the read, adopts that boundary, and applies only newer sequenced events. Reconnect replay resumes at the actual snapshot watermark, not an earlier error cursor; a stale replay result or error cannot replace it. An older runtime without this extension reports that it needs updating.
- Panel and model-catalog reads carry revision guards. Older reads cannot overwrite newer events or user mutations, even within the same session. Request results stay in their originating controller across navigation.
- Live model controls remain mounted through connection drops. Mutations are disabled until reconnection and capability discovery complete.
- Direct and queued sends retain structured attachments. A queue refusal is a failed submission, not success. Each submission has a persisted client ID and a server receipt, scoped by conversation and backend shard/tenant. Repeated IDs with different content are rejected. Accepted results survive service restart; concurrent retries share the original operation, which is shielded from RPC-caller cancellation. Retries query the receipt and retain the original direct/queue path. A crash or exception after execution starts without a completed receipt stays explicitly unresolved; it is never treated as permission to execute again.
- A failed/interrupted send is stored separately from text typed afterward. “Retry previous message” reconciles that original submission while preserving the follow-up draft, rather than concatenating the two and risking a duplicate send.
- The Send button remains available during a response and queues the follow-up, matching Enter. Stop remains a separate action.
- Submission is serialized per controller, including across two views of the same session. Queue refusal leaves an existing run active. Model-setting mutations block new submissions until the selection has settled.
- URL initial prompts belong to the initially selected session and are claimed once. Failure restores the prompt into that session's draft instead of silently consuming it.
- Escalation replies carry structured image/file content through `client_response`. The server validates it before consuming the question and returns SDK-native text/image/file tool outputs, so the model can actually inspect attachments. Resolved-question events dismiss the owning session's banner across views. An interrupted answer retains its original question ID; once that question is no longer pending, retrying cannot redirect the answer into another question or a fresh run.

## Implementation map

- `session/session-registry.ts`: connection-owned routing and lifetime.
- `session/conversation-session.ts`: fixed-identity session operations and state ownership.
- `session/session-transcript.ts`: protocol-event to transcript-machine adapter.
- `session/session-panels.ts`: revisioned session panel and model-control state.
- `hooks/use-chat-session.ts`: React subscriptions and fixed-owner action adapters; no connection listeners or identity mutation.
- `rpc-context.tsx`: pooled authenticated connections and reference-counted provider leases.
- `App.tsx`: selection boundary, session-bound presentation, and host integration.

## Server contract

`server_call(function="session.ensure")` creates or retrieves a session and applies supplied metadata. It does not mean the workspace is ready, the connection is ready, or a run has started. Goal startup, resident attachment/metadata refresh, and standalone terminals legitimately use it before a run.

`start_run` and the session model/reasoning/approval setters also create sessions when necessary. Ordinary chat does not need a defensive `session.ensure` call before each operation. Preserve the same conversation ID across these operations.

`enqueue_message.content` is the text prompt/display summary. The additive `input_content` array carries structured input parts to `start_run.content` when the queue drains. It is deliberately omitted from queue broadcasts so file data is not duplicated into every queue snapshot. Updated launcher and server versions are needed for queued attachments; an older server's refusal restores the draft instead of silently dropping files.

The generated `start_run.content` schema also accepts structured input arrays, matching the existing server implementation, while retaining string compatibility.

The protocol artifacts in this change were generated from the local omniagents working tree based on `c18b6ab2ca349da914cc92b791b55d9fbc637fdb`. Before release, commit the server change and re-sync with that commit as the provenance source; no commits are made as part of this task.

## Regression checks

The registry tests deliberately delay A's command and history responses while B receives events, simulate offscreen escalations and reconnect/resync, race queue snapshots with live updates, and submit from two views of one session. React tests verify subscription switching and model-state retention across view unmounts.

The expanded chat, tile, and voice test command passed 507 tests in 51 files:

```bash
npx --no-install vitest run src/renderer/omniagents-ui src/renderer/services/use-voice-capture.test.tsx src/renderer/services/voice-recording.test.ts src/renderer/features/Code/state.test.ts src/shared/machines/chat-session.machine.test.ts src/shared/machines/chat-boot.machine.test.ts
```

TypeScript, targeted ESLint/Prettier, protocol consistency, Electron production build, and browser/server builds were also checked. The server regression selection passed 172 tests; the shared storage contract passed 75 tests against a temporary live PostgreSQL 16 instance, including submission receipts and their deletion cleanup.

The permanent lifecycle spec covers six user stories: switching away from an active conversation and returning to its reply/draft; selecting the model before first-message startup; delivering an image queued during an active response; restoring an unsent draft/file after renderer reload; supplying an image when answering an agent question and recovering its lost acknowledgement; and dropping an accepted submission's RPC reply before retrying without duplicating its prompt. The fault injection closes the real socket after observing the acceptance response, without mocking any server result. All six passed in both Electron (1.8 minutes) and browser/server (2.1 minutes) against the final implementation. Visual proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-recovery-final-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=electron-local --output=artifacts/chat-recovery-final-electron-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-recovery-final-server-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=server-local --output=artifacts/chat-recovery-final-server-results
```

Electron report/results: `artifacts/chat-recovery-final-electron-report/index.html` and `artifacts/chat-recovery-final-electron-results/`. Browser/server report/results: `artifacts/chat-recovery-final-server-report/index.html` and `artifacts/chat-recovery-final-server-results/`. Results retain screenshots, traces, and videos.

## Additional recovery hardening

- Accepted-send reconciliation retains its submission identity until the authoritative history refresh succeeds. A failed refresh cannot make the next retry a new execution.
- Draft checkpoints and write failures are scoped to the conversation. Another conversation's successful save cannot mask a failed checkpoint, and another conversation's failed save cannot block a healthy checkpoint.
- Session preparation awaits IndexedDB restoration before reading or consuming saved model, reasoning, approval, and workflow choices.
- Client-tool execution and response delivery are separate: the controller caches the original result, marks it acknowledged only after successful delivery, and resends it on pending-request replay without executing the tool again. Transport errors are not reported as tool execution failures. The cache lasts for the controller's lifetime; this does not promise exactly-once client-tool execution across application crashes.
- Interrupted submission records include their staged context. Retry uses that original context after restart and does not clear newer staged context from the current composer.

Permanent regressions are in `session/session-recovery.test.ts` and `draft-storage.test.ts`. The lifecycle E2E spec additionally injects a recovery snapshot failure after a real accepted send loses its acknowledgement, then verifies that retry leaves only one user message. The snapshot error is intentionally injected; acceptance and receipt reconciliation use the real server.

Latest visual proof: all seven stories passed in browser/server (2.3 minutes) and Electron (2.1 minutes). Commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-five-fixes-server-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=server-local --output=artifacts/chat-five-fixes-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-five-fixes-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=electron-local --output=artifacts/chat-five-fixes-electron-results
```

Reports: `artifacts/chat-five-fixes-server-report/index.html` and `artifacts/chat-five-fixes-electron-report/index.html`. Screenshots, traces, and videos: `artifacts/chat-five-fixes-server-results/` and `artifacts/chat-five-fixes-electron-results/`.

## Cross-window drafts and background tools

Draft writes now apply field patches in one IndexedDB read/modify/write transaction, rather than replacing the entire row from a window's cache. Recovery fields carry a compare-and-swap revision: a stale window cannot claim or clear newer recovery state. BroadcastChannel sends only the changed conversation ID so other windows can refresh their drafts; correctness does not depend on receiving that notification. Unsaved ordinary fields, including File bytes, remain available for a subsequent write after a storage failure. Concurrent edits of the same ordinary field are last-write-wins; this is not collaborative text editing.

Hosts install client-tool capabilities with `ConversationSession.setToolHandler`. The controller retains them when views leave, replaces them when the host installs an updated handler, and releases them on disposal. View cleanup no longer revokes an active background session's tools.

Structured attachment content includes staged context alongside the original text and files. This applies to both direct and queued sends because structured content is the actual model input, not an addition to the separate prompt string.

The latest lifecycle proof includes a browser-only two-tab story with draft broadcasts disabled in the second tab, simulating a stale/suspended window. Its edit must preserve the first tab's pending submission, and retry must leave one user message. Isolated regressions additionally cover atomic competing recovery claims, attachment retention after quota errors, offscreen tool capabilities, and direct/queued structured context. All eight browser/server stories passed (2.7 minutes); all seven shared Electron stories passed (2.1 minutes), with the browser-only two-tab story explicitly skipped in Electron.

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-three-fixes-server-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=server-local --output=artifacts/chat-three-fixes-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-three-fixes-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=electron-local --output=artifacts/chat-three-fixes-electron-results
```

Reports: `artifacts/chat-three-fixes-server-report/index.html` and `artifacts/chat-three-fixes-electron-report/index.html`. Screenshots, traces, and videos: `artifacts/chat-three-fixes-server-results/` and `artifacts/chat-three-fixes-electron-results/`.

## Async lifecycle boundaries

Submission rechecks session readiness after asynchronous preparation and recovery checkpoint saves, immediately before issuing a direct send, queued send, or question response. Disposal during a save therefore rejects the operation without issuing its RPC. This does not cancel work already accepted by the server.

When another window wins a recovery checkpoint, subsequent draft broadcasts retain the losing window's unsaved text/files and pending input while adopting the authoritative recovery revision and submission. This allows an explicit retry without erasing the local prompt or requiring a reload.

Supervisor reset now waits for a successful stop before stopping its local machine and selecting a new conversation. A rejected stop rejects reset and leaves the current conversation selected.

Eight permanent regressions in `session/lifecycle-boundaries.test.ts` cover these exact boundaries, including queued sends, question replies, follow-up drafts, and retry after a conflicting write. The full chat selection passes 476 tests in 46 files. These races are covered by isolated tests; the existing lifecycle E2E suite checks broader user-visible behavior.

After these fixes, all eight browser/server lifecycle stories and all seven shared Electron stories passed; the browser-only two-tab story was skipped in Electron. TypeScript, targeted ESLint/Prettier, and both production builds passed. Visual proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-boundary-fixes-server-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=server-local --output=artifacts/chat-boundary-fixes-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-boundary-fixes-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts --project=electron-local --output=artifacts/chat-boundary-fixes-electron-results
```

Reports: `artifacts/chat-boundary-fixes-server-report/index.html` and `artifacts/chat-boundary-fixes-electron-report/index.html`. Screenshots, traces, and videos: `artifacts/chat-boundary-fixes-server-results/` and `artifacts/chat-boundary-fixes-electron-results/`.

## Generated UI in simultaneous tiles

`tests/e2e/specs/tile-generated-ui.spec.ts` drives two visible conversations through actual server tool execution. The deterministic model calls `display_artifact` and `task_create` in each, then `display_artifact` and `task_update` again. Both sessions deliberately use artifact ID `shared-report` and task ID `1`. Assertions verify separate initial content, independent updates, artifact replacement without duplication, expansion inside the owning tile, and ownership after closing and reconnecting the real sockets. The test explicitly waits for replacement open connections and editable composers before checking recovered content.

This covers the current canonical plan UI, not a legacy tool named `display_plan`. The initial version did not cover artifact-list navigation; the follow-up below fixes it and extends the test. This does not establish that every other UI event is correct.

Visual proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tile-generated-server-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts --project=server-local --output=artifacts/tile-generated-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tile-generated-electron-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts --project=electron-local --output=artifacts/tile-generated-electron-results
```

The final test passed in browser/server (29.7 seconds) and Electron (23.6 seconds). Targeted ESLint and Prettier checks passed. Reports are `artifacts/tile-generated-server-report/index.html` and `artifacts/tile-generated-electron-report/index.html`; screenshots, traces, and videos are retained in their respective `*-results` directories.

## Closing the Tile audit findings

- Local microphone capture has an explicit lifetime and operation generation. Unmount/cancel stops tracks, closes the audio context, disconnects nodes, and invalidates pending permission/transcription results. Duplicate acquisition is prevented, failed audio setup releases acquired resources, and delayed push-to-talk release can stop the newly started capture without relying on a stale render closure.
- Artifact-list navigation searches the owning chat column, never the whole document.
- Pointer/focus interaction activates the owning tile without triggering navigation scrolling. Global Focus and expand shortcuts use that identity; keyboard expansion uses the same persisted action as the button. Voice targeting prioritizes focused composers over hover, and closed columns clear their hover scope.
- Header action slots explicitly register their DOM targets. Persistent chat portals subscribe to target attachment/replacement, so Tile/Focus changes and reorder no longer depend on a render-time document lookup.
- Approval transport errors propagate instead of reversing an approval into a rejection. The owning card shows a retryable error and disables duplicate decisions while waiting; another tile's approval remains independent. This applies to function and MCP approval transport and the shared card used by chat and resident voice surfaces.
- Closing a tab rechecks active selection after saving its removal, preserving a newer selection made during that wait.

The targeted audit found and fixed the header timing, approval fallback, and close-selection bugs in addition to the three previously confirmed issues. Existing reset regressions verify that reset waits for stop success and does not switch conversations after stop failure. A delayed client-tool result is suppressed after controller disposal without affecting another session. These do not promise cancellation of a tool's already-started external side effects.

`tile-generated-ui.spec.ts` now closes each real socket during its artifact update, verifies recovered plans/artifacts, exercises same-ID artifact-list navigation, global Focus and expand keyboard targeting, and header controls after layout switches and keyboard reorder. `tile-lifecycle.spec.ts` verifies simultaneous questions with independent answers, archive of a question-bearing tile, reorder/archive during an active run, and two real pending tool approvals with one injected transport failure and retry. Mic resource and delayed-permission/transcription scenarios use fake media resources in isolated tests, not the user's microphone.

The intentional startup policy that adds/selects a fresh chat on reload is unchanged.

Final combined visual-proof commands for this batch:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tile-all-fixes-server-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/tile-lifecycle.spec.ts --project=server-local --output=artifacts/tile-all-fixes-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tile-all-fixes-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/tile-lifecycle.spec.ts --project=electron-local --output=artifacts/tile-all-fixes-electron-results
```

Reports: `artifacts/tile-all-fixes-server-report/index.html` and `artifacts/tile-all-fixes-electron-report/index.html`. Screenshots, videos, and traces: `artifacts/tile-all-fixes-server-results/` and `artifacts/tile-all-fixes-electron-results/`.

Final results: all 12 browser/server stories passed (4.6 minutes); all 11 shared Electron stories passed (3.6 minutes), with the browser-only two-tab story skipped. The expanded unit selection passed 507 tests in 51 files. TypeScript, targeted ESLint/Prettier, and both production builds passed. No commits or server changes were made in this batch.

## Authority-side chat mutations and approval identities

The subsequent concurrency audit is addressed at the ownership boundaries:

- `src/shared/chat-commands.ts` implements synchronous, side-effect-free chat commands against an authoritative snapshot. Desktop and browser-server handlers commit the returned chat-only patch once, then publish state. Creation/selection, archive/history/removal, history upserts, field changes, sidecars and layout updates no longer save renderer-owned whole lists. Reorder carries IDs only, ignores removed IDs and retains current fields. Routine-session creation uses the same boundary. Legacy renderer writes to the owned chat collections/selection are rejected.
- Renderer `Code/state.ts` is a typed command client. Process/terminal teardown runs after committed removal, using the tab returned by the authority. Repeated removals do not repeat teardown for a missing tab.
- Browser transport IDs belong to a window/emitter lifetime, not origin-wide local storage or cloneable session storage. Socket reconnect retains the ID; a new document gets a new transport and rehydrates durable chat state. This fixes a second window displacing the first window's event connection. Desktop store updates are published to all live windows.
- AgentService issues opaque approval tokens separately from provider tool IDs. Existing `call_id`/`request_id` wire slots now carry those tokens; `source_call_id`/`source_request_id` retain provider correlation as metadata. A token binds to one session/waiter. Authorization, replay, resolution and cleanup use that identity; duplicate provider IDs cannot overwrite waiters or retarget delayed replies.
- Approval decisions have a synchronous first-writer-wins boundary before permission effects. Exact retries return success without repeating grants, recording or broadcasts; conflicting decisions raise an error. Bounded retry receipts retain only identity/ownership, not whole sessions. Their lifetime is the running service (maximum 2048); expired/unknown tokens fail closed. Canonical decisions are recorded in conversation history; this does not claim that in-flight tools resume across a server restart.
- The client requires an explicit `true` acknowledgement; `false` leaves the approval unresolved locally and surfaces the existing error UI rather than silently dismissing it.

The authority boundary described here is one desktop main process or launcher-server process. It does not establish cross-replica PostgreSQL settings transactions; cloud replica-level persistence/concurrency remains a separate audit scope.

Protocol artifacts were regenerated from the local dirty OmniAgents checkout based on `c18b6ab2ca349da914cc92b791b55d9fbc637fdb`. Before release, commit the server changes and regenerate provenance from that committed source; no commit or publication was performed here.

### Concurrency verification

Client/state/transport/voice/machine tests: **548 passed, 56 files**:

```bash
npx vitest run src/shared/chat-commands.test.ts src/renderer/features/Code/state.test.ts src/renderer/omniagents-ui src/renderer/services/supervisor-bridge.test.ts src/renderer/transport/ws-transport.test.ts src/renderer/app/boot-landing.test.ts src/server/ws-handler.test.ts src/renderer/services/use-voice-capture.test.tsx src/renderer/services/voice-recording.test.ts src/shared/machines/chat-session.machine.test.ts src/shared/machines/chat-boot.machine.test.ts
```

Focused server approval, ownership, conversation-recording and replay tests: **79 passed** (run in the OmniAgents checkout):

```bash
/home/emm/Omni/Workspace/omni-code/.venv/bin/python -m pytest tests/unit/core/agents/test_approval_identity.py tests/unit/core/agents/test_agent_service.py tests/unit/core/test_agent_service_aux.py tests/unit/core/conversation/test_call_sites.py tests/unit/rpc/test_event_replay.py -q
```

The broader server sweep had **520 passed, 75 skipped, one failure** in the untouched `tests/unit/core/conversation/test_run_diff.py::TestObservation::test_a_path_outside_the_workspace_is_never_captured`. That failure reproduced independently using both project virtualenvs; it is not counted as passing or fixed. The skipped cases require PostgreSQL test configuration. See `/tmp/chat-server-regressions.log` and `/tmp/chat-unrelated-boundary-check.log` for this run's diagnostics.

Browser visual proof: **13 passed**. The new two-window test first exposed the shared transport-ID bug; after that fix, both windows remain live, both additions survive, and a held reorder cannot resurrect an archived tile. Existing stories also verify renderer reload, lost acknowledgements, draft/attachment recovery, questions, active-run closure, and plan/artifact routing. Approval stories deliberately use the same provider call ID in both tiles; the server unit tests additionally put colliding IDs on one shared AgentService.

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-architecture-final-server-report npx playwright test tests/e2e/specs/chat-window-concurrency.spec.ts tests/e2e/specs/chat-lifecycle.spec.ts tests/e2e/specs/tile-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=server-local --output=artifacts/chat-architecture-final-server-results
```

Report: `artifacts/chat-architecture-final-server-report/index.html`; screenshots/videos/traces: `artifacts/chat-architecture-final-server-results/`. The final JSON-null/undefined positional-argument normalization was covered separately by the reducer test and the final production rebuild.

Electron visual proof: **11 passed, one browser-only scenario skipped**:

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-architecture-electron-report npx playwright test tests/e2e/specs/chat-lifecycle.spec.ts tests/e2e/specs/tile-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=electron-local --output=artifacts/chat-architecture-electron-results
```

Report: `artifacts/chat-architecture-electron-report/index.html`; screenshots/videos/traces: `artifacts/chat-architecture-electron-results/`. Inspected the browser concurrent-create/archive screenshots and independent approval error, plus the settled Electron plan/artifact/header screenshot (`test-finished-1.png`). An immediate native capture caught the reorder transition mid-fade; the settled screenshot confirms normal rendering.

Final production builds (`npm run build`, `npm run build:server`), TypeScript, targeted ESLint/Prettier, Black checks, protocol-generation checks and `git diff --check` passed. The installed node-pty binary was restored to Electron ABI for the final native run. Nothing was staged, committed or published.

## Closing the pending-request recovery findings

The generic server-to-client request lifecycle now installs its waiter, session
ownership and replay payload **before** notification delivery can yield. Timeout,
cancellation (including during delivery), and run-end cleanup remove every pending
index. Terminal resolution events are journaled so a reconnect does not revive
an abandoned question.

Accepted replies retain a bounded receipt (2,048 per service lifetime): a SHA-256
fingerprint and lightweight owner, not the reply content or full Session. Exact
retries are authorized and acknowledged without consuming another response;
conflicts fail. Unknown or cancelled requests return false. Receipts are not
durable across agent-server restart; expired/missing identities fail closed.

The client requires a true acknowledgement before clearing a submitted answer.
An explicit false result is a definitive rejection, while malformed responses
and transport failures remain uncertain. After an acknowledgement is lost, the
client retries the original question ID even if a newer question has arrived;
absence from the pending snapshot alone no longer counts as successful delivery.
Cancelled automated tool responses release cached output without rerunning tools.

Permanent server coverage is in
`tests/unit/core/agents/test_client_request_lifecycle.py` and
`tests/unit/rpc/test_event_replay.py` (in omniagents). Client coverage includes
RPC acknowledgement validation, original-question retry ownership, cancellation,
and pending Tile recovery with deliberate loss of an accepted answer's ACK.

The unrelated workspace-boundary failure mentioned above was also resolved:
the test incorrectly assumed plain HostWorkspace was confined. Tests and API
docstrings now match the intentional host policy, while mounted-workspace tests
verify rejection of escaping absolute paths, traversal and symlinks without
reading or modifying the target.

All confirmed findings from these audits are addressed. Full agent-server restart,
cross-replica PostgreSQL operation and long-duration retention remain unverified
areas, not findings closed by this work.

Browser proof (three passed):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/client-request-fix-server-report npx playwright test tests/e2e/specs/tile-pending-recovery.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=server-local --output=artifacts/client-request-fix-server-results
```

Report: `artifacts/client-request-fix-server-report/index.html`.
Screenshots/videos/traces: `artifacts/client-request-fix-server-results/`.
The malformed-acknowledgement guard was tightened after this browser build and
is covered by client unit tests and the subsequent native build.

Final unit verification: 536 server tests passed, 75 PostgreSQL-dependent tests
skipped; all 384 chat-client tests passed. TypeScript, targeted ESLint/Prettier,
Black and `git diff --check` passed. The permanent server tests additionally
exercise cancellation while notification delivery is suspended, session-to-session
isolation, run-end fallback cleanup, receipt ownership and bounded retention.

Native proof command (after rebuilding node-pty for Electron):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/client-request-fix-electron-report npx playwright test tests/e2e/specs/tile-pending-recovery.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=electron-local --output=artifacts/client-request-fix-electron-results
```

Report: `artifacts/client-request-fix-electron-report/index.html`.
Screenshots/videos/traces: `artifacts/client-request-fix-electron-results/`.
All three native stories passed (1.3 minutes). Nothing was staged, committed or
published; existing worktree changes were preserved.

## Subsequent verification: new open findings

The previously unverified PostgreSQL/restart/retention boundaries have now been
exercised. PostgreSQL conversation/history tests passed (84), as did graceful
server restart and concurrent submission receipt claiming. Verification exposed
four additional open issues: settings-cache lost updates (including across teams),
swallowed database persistence failures, indefinitely retained document transport
sessions, and actionable orphaned approvals after a hard server crash.

See `artifacts/chat-review/restart-replica-verification.md` for scope, exact
commands, permanent reproductions and crash proof. These findings supersede the
earlier statement that all then-confirmed issues had been addressed; this
verification pass did not modify production behavior to fix the new findings.

# September 6 follow-up: database authority, document expiry, crash controls

- PostgreSQL chat commands now read/reduce/write while holding a transaction-scoped
  lock for the principal's settings row, including when that row does not exist
  yet. The RPC returns only after commit. Generic settings writes merge their
  field patches into the current document rather than replacing another cache's
  updates. Other teams' overlays survive. Queued local optimistic settings reads
  are preserved without replaying chat commands or generating duplicate IDs.
- Persistence errors reach the durability barrier and the settings RPC; failed
  commands roll back and do not poison subsequent writes. Cache reloads are
  revision-guarded, and database notifications refresh sibling caches on the same
  replica as well as remote replicas.
- A disconnected document keeps its handlers/console resources for 60 seconds
  to permit socket reconnection, then expires. Reattachment cancels expiry;
  active documents are not expired. Replaced sockets are closed and cannot route
  commands through a fallback tenant. Shutdown awaits outstanding expiry cleanup.
- Runtime snapshots join persisted approval/elicitation history with actual live
  waiters owned by that session. After a hard crash, dead controls become
  historical/unavailable rather than offering a decision the server cannot use.
  This is a runtime projection, not a destructive rewrite of shared history or a
  claim to resume interrupted tools. Live prompts, durable plans and artifacts
  retain their existing behavior.
- Two older approval-routing tests now use the emitted opaque approval token,
  while checking that the provider call ID remains available as source metadata.

Verification details and proof commands: `artifacts/chat-review/chat-fixes.md`.
