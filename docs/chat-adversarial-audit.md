# Staged chat reliability audit

Requested 2026-09-06. Continue stages autonomously, preserving existing work.
Fix confirmed bugs with focused regression coverage; distinguish proven behavior
from untested infrastructure. Do not deploy or change shared infrastructure.

## Stages

### Current follow-up (2026-09-07)

#### Completed: transactional runtime mutations and injected-message recovery

Implemented in omniagents, preserving the existing launcher ownership architecture:

- Append-only queued messages and mid-run user messages now journal projection
  intents with their raw history writes. Recovery uses queue IDs / reserved
  occurrence identities, drains before later items, and acknowledges only after
  canonical recording. This closes the history-to-transcript crash window, not
  the earlier queue-acceptance boundary.
- Queue snapshots now include `input_content`, preserving attachment data.
- Turn start atomically commits the turn, ordinal, prompt, title and counters.
  Process death at prompt insertion, turn insertion or thread update leaves none
  of the turn behind; retry creates exactly one turn/prompt.
- Turn settlement and usage rollup are one transaction. Late token/status events
  do not rewrite settled totals/model/attempts. Concurrent appends cannot have
  their counters overwritten by turn metadata writes.
- Runtime item transitions and artifact revisions now read/modify under database
  locks. Concurrent terminal results keep the first terminal outcome; concurrent
  artifact revisions preserve each patch and advance revisions monotonically.
- Thread metadata, archive and compaction-floor patches apply to current locked
  rows. Compaction floors cannot move backward under out-of-order writers.
- SQLite uses `BEGIN IMMEDIATE`; PostgreSQL follows thread-then-turn/item lock
  ordering. Raw import/projection upserts remain separate from runtime mutations.

Verification: final backend session/runtime/conversation/agents/replay selection
**1,113 passed**; PostgreSQL **109 passed** (no skips); launcher targeted state
suite **179 passed**; TypeScript, Black and diff checks passed. Real subprocess
tests also cover death during turn-end usage rollup. Browser **3 passed**;
server restart **2 passed** (graceful and forced); native Electron **2 passed**.
Existing components and styles were retained under the shadcn skill; no
launcher runtime UI changes were needed in this stage.

Native screenshot review found the host tiling compositor cropped several
`atomic-chat-electron-results` images despite passing assertions. Those images
are not full-window visual proof. An isolated localhost-only Xvfb/Openbox
display is used for the replacement native run (`atomic-chat-x11-*`), with no
host desktop configuration changes.
That run also passed both stories, but image review found native `capturePage`
could return an older compositor frame after successful DOM assertions. The
shared Electron fixture now uses Playwright's renderer screenshot path, matching
browser proof capture. The final regenerated evidence is in
`atomic-chat-native-proof-report/index.html` / `atomic-chat-native-proof-results`.
Both regenerated native stories passed. Reviewed the full-width updated
plan/artifact screenshot (A and B each retain their own content) and the
archive/restore screenshot (only the neighbor retains its live approval).
The temporary PostgreSQL and Xvfb/Openbox containers were stopped and removed;
only disposable test data was discarded. Existing containers were untouched.

Remaining boundaries, explicitly not claimed fixed:

1. Pending queue acceptance and buffered notifications are memory-only until
   draining. A process death while waiting can lose this work. The architectural
   follow-up is a durable command inbox with atomic acceptance/receipt, dispatch
   claims, cancellation and explicit uncertain-dispatch recovery—not automatic
   replay of a saved queue, which could duplicate externally effective runs.
2. Tool execution, approval decisions, event journaling and canonical recording
   still have separate durability boundaries. Atomic item transitions fix stale
   updates, not arbitrary crash recovery or exactly-once external tool effects.
3. Historical repair remains separate and unapproved; original databases are
   untouched. Azure remains excluded.

Proof commands (repo: launcher):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/atomic-chat-server-report npx playwright test tests/e2e/specs/chat-persisted-response.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts --project=server-local --output=artifacts/atomic-chat-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/atomic-chat-electron-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=electron-local --output=artifacts/atomic-chat-electron-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/atomic-chat-restart-report npx playwright test tests/e2e/specs/tile-server-restart.spec.ts --project=server-local --output=artifacts/atomic-chat-restart-results
DISPLAY=127.0.0.1:99 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/atomic-chat-x11-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=electron-local --output=artifacts/atomic-chat-x11-results
DISPLAY=127.0.0.1:99 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/atomic-chat-native-proof-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=electron-local --output=artifacts/atomic-chat-native-proof-results
```

Each `*-report/index.html` is the proof report; each corresponding `*-results`
directory contains retained screenshots, video and traces. Profiles and model
servers are isolated; model replies are deterministic local fixtures.

#### Completed: process-death durability, SDK context, delayed tile updates

Stage 1 — write boundaries:

- Canonical item insertion previously committed sequence allocation, the item,
  thread count and turn count separately. Replaced that path with atomic
  `ConversationStore.append_item` on SQLite and PostgreSQL. Same-identity
  concurrent writers return one item without incrementing counts twice.
- New completed provider responses now commit a projection intent alongside
  their history row. Canonical reads and subsequent item writes drain these
  intents; acknowledgment follows atomic canonical insertion. Real subprocess
  deaths after history commit and after domain commit both recover exactly
  once, before a later checkpoint. No historical rows are auto-enrolled.
- History-write failure no longer leaves a phantom message in Session memory.
  Initial canonical-owner unavailability rejects the opted-in write rather
  than accepting a response without a recoverable owner.

Stage 2 — cancellation / compaction context:

- Confirmed SDK clear/pop only changed memory, allowing old model context to
  return after restart. Added a separate durable SDK-context view; the raw
  transcript remains append-only. Subsequent appends update history, recovery
  intent and the context view in one history transaction.
- Omni's SDK compaction wrapper now replaces that view atomically instead of
  clear-then-add. Process-death tests prove replacement is either the old or
  new context, never an intermediate empty context. Failed replacement leaves
  both memory and storage unchanged. `get_items(limit=0)` now returns no items.
- Full forks inherit compacted context; historical branch-point forks retain
  their prefix and do not inherit the parent's later context.

Stage 3 — delayed tile updates:

- Added deferred canonical-read regressions across a new run, authoritative
  rehydration, and disposal followed by a new controller with the same session
  ID. Old output retains its original turn, cannot overwrite a newer revision,
  cannot enter another tile, and cannot mutate a replacement controller.
  These passed without another launcher runtime patch. Per shadcn guidance,
  existing components were retained; this stage changes state tests only.
- Browser hidden-stream and missing-stream recovery proofs pass. Browser
  archive/lost-reply proof also passes: the neighbor's approval remains active
  while the restored owner has no stale approval. Native Electron recovery
  proof passes. Reviewed native recovery and browser archive screenshots.

Verification: broad SQLite session/runtime/conversation suite **802 passed**;
service/enqueue/replay **64 passed**; final focused crash/audit/outbox checks
**32 passed** (including subsequently added fail-closed coverage); disposable
PostgreSQL shared contract/context suite **97 passed**; launcher **179 passed**.
TypeScript, targeted ESLint, Black and diff checks passed. The first broad
run had five fixture failures from positional inserts assuming a three-column
history table; explicit column names fixed the fixture, and the broad rerun
passed. PostgreSQL container `omni-chat-crash-pg` was stopped/removed after
verification; only disposable test data was discarded. Native modules remain
on Electron ABI. Azure verification remains excluded.

Backend design and guarantee boundaries: `omniagents/docs/CHAT_WRITE_DURABILITY.md`.
This is durable replay for newly opted-in provider responses, not a transaction
covering every legacy prompt/tool/metadata writer, nor a repair of the four
historical discrepancies. No original conversation databases were modified
during verification.

Proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/crash-recovery-server-report npx playwright test tests/e2e/specs/chat-persisted-response.spec.ts tests/e2e/specs/background-tile-lifecycle.spec.ts --grep 'persisted response|owns stream' --project=server-local --output=artifacts/crash-recovery-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/crash-recovery-electron-report npx playwright test tests/e2e/specs/chat-persisted-response.spec.ts --project=electron-local --output=artifacts/crash-recovery-electron-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/crash-archive-server-report npx playwright test tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=server-local --output=artifacts/crash-archive-server-results
```

Reports: `artifacts/crash-recovery-server-report/index.html`,
`artifacts/crash-recovery-electron-report/index.html`,
`artifacts/crash-archive-server-report/index.html`.
Results (screenshots, videos, traces): `artifacts/crash-recovery-server-results/`,
`artifacts/crash-recovery-electron-results/`, `artifacts/crash-archive-server-results/`.

#### Completed: checkpoint-aware audit and persisted-response delivery

- Audit now compares messages and compaction checkpoints in relative order,
  using the adapter's checkpoint classification. Reports separate message and
  checkpoint counts/match flags; missing checkpoints, changed versions and
  misplaced checkpoints remain review-required. Five new audit cases pass.
- Reproduced a current omission with the **real installed Agents SDK**, an
  offline model and a session hook that fails after saving output. When the
  producer fails before the consumer drains events, the SDK raises and drops
  the queued message event. Before the fix, legacy history retained the
  response while canonical history had zero assistant messages. This proves
  the failure class, not the exact cause of the historical HTTP 404.
- Completed, provider-identified assistant output is now recorded at history
  persistence time, with the same identity as stream recording, before a later
  compaction can land. Persistence publishes a session-scoped `item_updated`.
  Old input rows re-saved by the SDK do not create new responses after legacy
  projection. Partial output, checkpoints and ID-less injected messages are
  not guessed into this recording path.
- Launcher retains provider message IDs through streaming and canonical
  adaptation. It merges the two arrival orders by identity, accepts canonical
  output with no stream event, and preserves equal text with distinct IDs.
  Retrieved item identity/thread must match the request before adoption.
  Tests cover owner isolation and delayed/absent stream events. Existing UI
  components and layout were retained; no component/style migration was needed.
- Read-only local re-audit still flags four sessions, but no longer calls
  summaries assistant messages. The `b05df199...` messages and checkpoint all
  match; its checkpoint is after 71 messages in legacy versus 70 in canonical.
  This newly measured ordering discrepancy remains explicit, rather than
  silently being treated as matched. The `935c21dd...` case has one missing
  assistant message, not two. No historical stores were repaired or modified.
- Verification: 320 backend runtime/recorder/audit/session tests passed; 176
  launcher tests; TypeScript, targeted ESLint, server/browser and Electron
  production builds. The permanent proof story passes in both server and
  Electron modes: suppress the stream message (retaining its replay sequence
  slot as a token), observe the actual persisted-item notification, verify one
  response in tile A only, retain tile B's draft, then reload and verify again.
  This UI injection is distinct from the real SDK failure regression above.
  Both owning-tile screenshots were inspected. Native modules are Electron ABI.

Proof commands (one passed in each mode):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/persisted-response-server-report npx playwright test tests/e2e/specs/chat-persisted-response.spec.ts --project=server-local --output=artifacts/persisted-response-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/persisted-response-electron-report npx playwright test tests/e2e/specs/chat-persisted-response.spec.ts --project=electron-local --output=artifacts/persisted-response-electron-results
```

Reports: `artifacts/persisted-response-server-report/index.html` and
`artifacts/persisted-response-electron-report/index.html`.
Results (screenshots, videos, traces): `artifacts/persisted-response-server-results/`
and `artifacts/persisted-response-electron-results/`.

#### Historical discrepancy investigation (read-only)

Investigated all four flagged sessions using SQLite read-only connections;
no original conversation stores were changed and no repair copy was created.
Compared exact normalized text, stable message IDs, compaction provenance and
turn metadata, without copying conversation text into this document.

- `21a1eeaa-297f-4372-8690-4c041d8a3779` (185 legacy / 172 canonical messages):
  the 13 unmatched legacy rows are two duplicated assistant records and 11
  user-input rows whose text is already represented by canonical prompts.
  Both assistant copies have identical raw records and stable IDs elsewhere in
  legacy history, and exact text/ID matches in canonical history. Repeated
  user-input batches also reuse legacy IDs. Evidence points to historical
  input reserialization/duplication, not 13 missing unique chat messages;
  text equality alone is not sufficient to infer user-intent identity.
- `b05df199-5c7c-4d14-af66-049d9e38785a` (110 / 109): the extra assistant-role
  row 111757 is explicitly tagged `omniagents.kind=context_summary`. Its text
  exactly matches canonical compaction item 672. This is an audit false
  positive, not a missing assistant response.
- `935c21dd-433b-4d7a-b4c6-906cc70b24ca` (76 / 74): row 110718 is likewise a
  context summary, exactly represented by compaction item 496. However, row
  110717 is an 844-character completed assistant response with unique ID
  `msg_049d7cc4db4f885e016a825533005887d1913e575d2cff00d0`; neither its text nor
  ID appears in canonical history. It precedes the existing compaction.
  The last turn, `run_1565b6474a89439b8f334af96822d6d6`, ended with
  `NotFoundError` (HTTP 404). The event journal retains zero events for this
  session (compacted through sequence 1226), so the original failure path
  cannot be reconstructed from replay. The gap is confirmed; its cause and
  reproducibility in today's runtime are not yet established. Append-only
  repair would put the response in the wrong position and remains refused.
- `session-e2e-host-first-message` (7 / 5): three historical assistant rows
  reuse `msg_e2e_host_first_message`. The recorder keys provider messages by
  message ID within a thread, so these collide into one canonical message.
  Today's model-server fixture generates a fresh UUID per response and derives
  the message ID from it. This historical fixture collision is not evidence
  that production message deduplication should be weakened.

Follow-up proposed at investigation time (now implemented above): make the audit checkpoint-aware (the canonical adapter
already classifies these rows as compactions), with regression coverage for
checkpoint-only and checkpoint-plus-real-gap cases. Separately reproduce an
SDK-persisted assistant response followed by stream failure before its
`message_output` event reaches canonical recording. Current persistence and
event recording are separate paths, but this inspection alone does not prove
that failure ordering occurs today. Do not modify historical ordering without
an explicit, provenance-preserving repair design and approval.

Historical repair / background lifecycle / PostgreSQL follow-up:

- Added backend `omniagents.core.conversation.history_audit`: read-only SQLite
  audit, plus explicit repair-to-new-copy for an exact canonical prefix followed
  only by plain user messages. It refuses ambiguous ordering, active turns,
  multimodal/assistant/system suffixes, existing outputs and missing inputs.
  Original stores are never initialized/migrated/written. Recovered records
  retain row-ID provenance and are marked inferred (`source=adapter`).
- Nine regression cases pass, including original-byte preservation, repeated
  identical messages, idempotence, sequence allocation, refusal boundaries,
  private output permissions and preservation of unrelated threads/revisions.
  Operational instructions: `omniagents/docs/HISTORY_REPAIR.md`.
- Read-only audit of the local `omni_code/omni` store: 132 matching message
  sequences, 842 legacy-only sessions, four ambiguous differences, two running
  sessions. No safe suffix was identified and no user-data repair copy was made.
  Three ambiguous sessions are non-test sessions; one is an old E2E session.
  Differences include assistant rows and missing middle messages, so appending
  guesses at the end would be incorrect. This is not a full-history-clean bill.
- PostgreSQL 16 ran in a disposable localhost-only Docker instance. All 84
  existing conversation/session-history PG tests passed. Added an eight-way
  concurrent submission-claim regression shared by SQLite and PostgreSQL.
  Combined store/parity/replay/history-audit suite: 178 passed, no skips.
- Background lifecycle browser proofs pass: real model responses are gated until
  the owning tile is hidden. Shared tests exercise streaming, approval and
  artifact/plan arrival, Focus/Spaces, resizing, independent drafts and artifact
  navigation. Electron additionally minimizes/restores the actual window;
  server mode does not claim native minimization coverage.

Browser commands (four main stories plus the strengthened hidden-approval check
all passed):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/background-tile-server-report npx playwright test tests/e2e/specs/background-tile-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=server-local --output=artifacts/background-tile-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/background-approval-server-report npx playwright test tests/e2e/specs/background-tile-lifecycle.spec.ts --grep 'owns approval' --project=server-local --output=artifacts/background-approval-server-results
```

Reports: `artifacts/background-tile-server-report/index.html`,
`artifacts/background-approval-server-report/index.html`.
Results: `artifacts/background-tile-server-results/`,
`artifacts/background-approval-server-results/` (screenshots, videos and traces).
Reviewed background artifact/plan screenshot: owner A only, B's draft retained.
Native default-desktop attempt: the existing generated-UI story passed, but all
three minimization stories stopped at the precondition: `isMinimized()` stayed
false after `BrowserWindow.minimize()`. Report retained at
`artifacts/background-tile-electron-report/index.html`; results in
`artifacts/background-tile-electron-results/`. No app fix or assertion weakening
was inferred from this desktop limitation. An isolated Docker Xvfb/Openbox
display on localhost port 6099 was used for an actual minimized-window
proof, with `E2E_ELECTRON_X11=1` forcing Electron's X11 backend. No host desktop
configuration was edited. All four native stories passed on that display;
the container and temporary helper were removed after verification.

Native command (with a running isolated X11/Openbox display):

```bash
DISPLAY=127.0.0.1:99 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/background-tile-x11-report npx playwright test tests/e2e/specs/background-tile-lifecycle.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=electron-local --output=artifacts/background-tile-x11-results
```

Report: `artifacts/background-tile-x11-report/index.html`.
Results: `artifacts/background-tile-x11-results/` (screenshots, videos, traces).
Reviewed the native artifact/plan/sidebar screenshot. No new launcher runtime
bug was reproduced in this pass. Native modules remain restored to Electron ABI.
Physical machine sleep/wake and Azure/interactive external identity-provider
verification are not covered by these local minimization proofs.

Types, targeted ESLint/Prettier, 83 session/code-state unit
tests and Python Black checks pass. Disposable PG container was stopped/removed;
only test data was discarded. No user data was modified or migrated.

Logs: `/tmp/chat-history-local-audit.json` (IDs/counts only),
`/tmp/chat-history-audit-final-tests.log`, `/tmp/chat-audit-postgres.log`,
`/tmp/chat-audit-parity-final.log`.

Remaining login/history verification pass — local login recovery and browser/native history stress verified:

Follow-up after approval to preserve/edit the dirty backend worktree:

- Added canonical recording for append-only queued messages, keyed by queue
  identity (not text), without attaching them to an already-completed run.
  Materialization precedes the history append to avoid projection duplicates.
  Existing user, assistant and system roles are retained.
- The queue publishes session-scoped `item_updated` notifications. Launcher
  now fetches/adopts these queued messages through its existing canonical
  revision handler; ordinary streamed messages remain excluded to avoid twins.
- Regression covers repeated identical messages, idempotent recording, owning
  session isolation and live notifications. The real-store browser story now
  requires live arrival before reloading, not just successful hydration.
- Initial post-fix browser proof persisted all 1,500 injected messages and
  passed login recovery, but exposed a real reading-position reset after
  Focus/Spaces switches. Inactive chats used `display:none`; their zero-sized
  content caused the scroller to reacquire the bottom lock. Inactive Focus
  panes now retain geometry while invisible, inert and aria-hidden. Existing
  scrolling primitives still own streaming follow and jump-to-latest.
- Verification so far: 745 renderer tests, 84 chat-machine tests, 484 backend
  conversation/queue tests (75 PostgreSQL-dependent tests skipped), and 18
  agent/submission tests pass. Types, targeted lint and formatting pass.
  Browser and native history stress both pass; screenshots reviewed.

Evidence: `/tmp/queue-canonical-baseline.log` (all three roles fail before fix),
`/tmp/queue-backend-suite.log`, `/tmp/queue-agent-regressions.log`,
`/tmp/queue-scroll-renderer-suite.log`, `/tmp/queue-machine-unit.log`.
The first post-recording-fix report preserves the scroll regression at
`artifacts/queue-history-server-report/index.html`, with results under
`artifacts/queue-history-server-results/` (one pass, one failure).

Final browser history proof (passed):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/queue-history-final-server-report npx playwright test tests/e2e/specs/chat-large-history.spec.ts --project=server-local --output=artifacts/queue-history-final-server-results
```

Report: `artifacts/queue-history-final-server-report/index.html`.
Results: `artifacts/queue-history-final-server-results/` (screenshots, video, trace).
Verified live arrival, all 750 rows per session after reload, streaming while
scrolled up, three Focus/Spaces switches, jump-to-latest and independent draft.
The attached hydration measurement was 3,393 ms for this local proof run
(includes reload/UI assertions; not an isolated rendering benchmark).
Reviewed the final screenshot. The intermediate `queue-scroll-server-report`
passed scroll retention but exposed a test visibility assumption: selecting B
can pan A's left-aligned response behind the sidebar. The test now reveals A's
outer column before asserting its retained inner scroll and clicking jump.
It does not scroll the response into view or weaken the inner-scroll assertion.

Final native proof (passed):

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/queue-history-final-electron-report npx playwright test tests/e2e/specs/chat-large-history.spec.ts --project=electron-local --output=artifacts/queue-history-final-electron-results
```

Report: `artifacts/queue-history-final-electron-report/index.html`.
Results: `artifacts/queue-history-final-electron-results/` (screenshots, video, trace).
Same two-session story passed in Electron in 1.3 minutes. Native modules remain
on Electron ABI. Existing changes were preserved; nothing staged or committed.
This fixes newly processed queue entries; no migration of historically omitted
canonical records was performed. Azure/external identity-provider verification
remains excluded; PostgreSQL tests needing an external test DSN were skipped.

- Confirmed/fixed browser shell HTTP 401/403 retry loop. Explicit rejection of
  the credential used to mint a fresh WS token is terminal; stale WS tokens
  themselves still refresh/retry under the existing local policy.
- Confirmed/fixed auth-gate bootstrap rejection spinner and stale credential
  snapshot overwriting a newer sign-out. The gate now reports read failure
  with a Reload action, subscribes before reading, and fences obsolete reads.
- Browser cold-start proof found an earlier failure boundary: store/system
  initialization rejected before AuthGate mounted. Store initialization now
  publishes an explicit error state; SystemInfoLoadingGate and AuthGate reuse
  StartupError (existing Alert/Button primitives) for an actionable failure.
- Added accessible name to the existing jump-to-latest button.
- Added permanent browser credential-rejection/cold-start/attachment-recovery
  story and a real-store 1,500-item, two-tile streaming/scroll stress story.
  Local credential restoration simulates the identity-provider boundary;
  no Azure/Entra deployment or interactive external identity provider is used.

Fail-before-fix evidence: `/tmp/auth-shell-baseline.log`,
`/tmp/auth-gate-baseline.log`, `/tmp/history-button-baseline.log`.

Verification: 744 renderer tests pass (`/tmp/remaining-renderer-unit.log`),
TypeScript and targeted ESLint pass, browser and native builds pass. The full
renderer run exposed an editor test assuming exactly one known jsdom CSS parse
diagnostic. It also failed in isolation (`/tmp/context-editor-isolated.log`).
Its rendering checks and rejection of all unexpected diagnostics remain;
the incidental stylesheet-injection count is no longer fixed to one.

Browser command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/login-history-verified-server-report npx playwright test tests/e2e/specs/chat-login-recovery.spec.ts tests/e2e/specs/chat-large-history.spec.ts --project=server-local --output=artifacts/login-history-verified-server-results
```

Report: `artifacts/login-history-verified-server-report/index.html`.
Results: `artifacts/login-history-verified-server-results/`.
**One pass, one failure:** browser login rejection, cold-start recovery, reload
after restoring credentials and single submission with original attachment bytes
passed. The history test failed before scroll/stream stress: after 750 accepted
non-triggering enqueues, `queue_status(include_snapshot=true)` returned only the
original two canonical items. `Session.append_message` persists legacy history
but records only reasoning explicitly; the non-triggering queue drainer does
not explicitly record its user messages. By contrast, `send_user_message`
explicitly records that equivalent non-broadcast history write.

Backend files implicated: `omniagents/core/agents/service.py` (queue drainer),
`omniagents/core/session/manager.py` (append_message), and
`omniagents/core/conversation/recorder.py`. All are already modified in the dirty
backend worktree. Its AGENTS.md required surfacing that state and waiting for
guidance; no backend files were changed during that earlier pass. The user
subsequently approved preserving/editing these files; see the follow-up above.
Native visual proof for that earlier pass was pending;
native dependencies were restored to Electron ABI with `npm run rebuild` after the browser/server fixture.

The initial combined report (`artifacts/login-history-server-report/index.html`)
also retains the cold-start spinner failure and a history-test setup mistake
(it initially queried tile containers while still in Focus mode).

Next transport/history pass (2026-09-07):

- Fixed locally, browser and native proofs passed: silently open RPC connection
  recovery. After idle traffic, a bounded session-free `get_agent_info` read
  checks the full application path. Its timeout retires only its own socket,
  rejects outstanding local waits and enters existing reconnect/replay recovery;
  it never resends mutations. The single probe reserves one request slot so
  saturation cannot disable recovery. Disposal and replacement cancel/fence it.
- Fixed locally: HTTP 401/403 ticket rejection parks the chat connection rather
  than retrying the same rejected credentials forever. Other HTTP/network
  failures remain transient. Voice had the inverse bug: temporary ticket
  outages were terminal; it now uses the same explicit rejection classification.
  Updated credentials use the existing credential-keyed provider replacement.
- Large-history pagination check passes with 1,500 items, overlapping pages and
  a higher revision at a page boundary. This is not yet a browser performance
  or scroll/stream/tile stress proof. Current modern hydration uses an atomic
  full snapshot; the pagination check covers the legacy canonical loader.

Fail-before-fix evidence: `/tmp/silent-auth-baseline.log`,
`/tmp/realtime-ticket-baseline.log`, `/tmp/liveness-capacity-baseline.log`.
443 chat UI unit tests pass (`/tmp/silent-final-unit.log`). Physical sleep/wake,
full user reauthentication through a real expired login, and large-history
scroll/stream/tile stress remain unverified. Azure remains excluded.

Browser visual proof passed (1.4 minutes) using:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/silent-tiles-verified-server-report npx playwright test tests/e2e/specs/chat-silent-connection.spec.ts --project=server-local --output=artifacts/silent-tiles-verified-server-results
```

Report: `artifacts/silent-tiles-verified-server-report/index.html`.
Results: `artifacts/silent-tiles-verified-server-results/`. Screenshot reviewed:
two visible tiles, first recovered message appears exactly once in its own
transcript, second draft remains unsent and only in the second composer.
The fixture drops application frames in both directions without closing the
original socket. Replacements are allowed to communicate normally.

The initial tile runs exposed an invalid recovery assertion: the test waited
for any replacement, not the endpoint belonging to the tile it then submitted
from. In the first browser run (`artifacts/silent-tiles-server-report/index.html`)
Enter did not submit during rehydration. In the first native run
(`artifacts/silent-tiles-native-report/index.html`), Send reached the still-stalled
connection and was correctly rejected with `Connection liveness check timed out`;
the draft was restored intact. The corrected fixture tracks active endpoints,
waits for every affected endpoint's replacement handshake AND retirement of
every original faulted socket, then uses the visible Send button. Multiple
management/chat connections can share one URL: the intermediate native run
(`artifacts/silent-tiles-verified-native-report/index.html`) demonstrated that
matching replacement URLs alone was still insufficient. It also restored the
draft with an explicit liveness error instead of losing or duplicating it.
The fixture never retries the mutation automatically. The original
single-chat proof also passed (`artifacts/silent-connection-server-report/index.html`).

Final native proof passed (1.4 minutes) using:

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/silent-tiles-final-native-report npx playwright test tests/e2e/specs/chat-silent-connection.spec.ts --project=electron-local --output=artifacts/silent-tiles-final-native-results
```

Report: `artifacts/silent-tiles-final-native-report/index.html`.
Results: `artifacts/silent-tiles-final-native-results/`. Final native screenshot
reviewed (the capture shows the first transcript and part of the second tile;
the automated DOM assertions verify both drafts and transcript ownership). The browser
pass above preceded the final stricter fixture assertion; product code was the
same. Native dependencies are left rebuilt for Electron.

Production browser/Electron builds, TypeScript, targeted ESLint/Prettier and
`git diff --check` pass. No backend edits, commits or shared infrastructure
changes were made in this pass.

1. Complete locally: competing independent drafts/submissions in two windows;
   durable conflict copies and explicit restore preserve both intents. Composer
   identities and receipt recovery prevent duplicate sends/optimistic bubbles.
2. Complete locally: archive/environment changes while an upload is pending.
   Environment-version fencing prevents dispatch after replacement.
3. Complete locally: reconnect during older hydration schedules a fresh read.
   Browser and native multi-tile recovery and missed model/reviewer updates pass.
   Simulated faults are not physical operating-system sleep/wake verification.

### Original audit

1. **Complete locally — authorization beyond launcher `/ws`.** Audit `/ws/chat`, HTTP
   APIs, runtime tokens and proxies for revoked-member access. Preserve the
   intentional distinction between human membership and agent/bridge credentials.
2. **Complete — transport fault injection.** Lost submission acknowledgements,
   interrupted snapshots, delayed/duplicate events: verify durable retry IDs,
   exactly-once acceptance and recovery without lost conversation content.
3. **Complete — three-tile UI adversarial coverage.** Seeded lifecycle actions
   during streaming, questions/approvals, generated plans/artifacts and uploads;
   assert each item, draft and operation stays with its owning conversation.
4. **Verified — missed PostgreSQL notifications.** Interrupt notification delivery
   and verify replica caches recover current authoritative state.
5. **Complete — resource soak.** Repeated connect/disconnect/reload/session churn
   over a sustained run; inspect retained sockets, handlers, timers and requests.
6. **Local simulation verified; Azure verification skipped by user — authentication edge / load balancing.** Exercise local replicas
   behind a controlled proxy, including reconnect routing and identity isolation.
   Real Azure edge verification requires an available authorized deployment;
   local simulation must not be represented as that proof.
7. **Complete locally — final verification and handoff.** Relevant unit/integration tests,
   TypeScript/lint/build checks, native browser/Electron visual proof for changed
   user stories. Record commands, results, artifacts and residual limitations.

## Concurrent drafts, retirement and offline recovery follow-up — complete locally

Requested 2026-09-07: proceed with all three next investigation areas.

Confirmed findings and fixes:

- Independent stale draft edits overwrote each other. Draft content now has a
  revision, and conflicting versions are saved atomically as `otherDrafts` in
  IndexedDB. The composer uses existing Alert/Button components to expose an
  explicit restore action; restoring preserves the current nonempty draft too.
- Text and attachments were merged independently, letting a stale text edit
  inherit another window's files. They now form one versioned intent.
- A losing recovery claim previously remained optimistic and unsaved. It now
  persists its losing input as a conflict copy, adopts the authoritative claim,
  and refuses dispatch. The copy uses the originating draft revision so a draft
  already preserved by a competing send is not duplicated. Conflict errors are
  distinguished from storage-capacity failures.
- Attachment encoding could finish after an environment generation changed and
  still dispatch the stale operation. Session sends capture an environment
  revision at admission and check it at asynchronous dispatch boundaries.
  Already-disposed owners were correctly fenced; the new archive/upload story
  passes without another archive implementation change.
- A reconnect during unfinished hydration joined the old connection's load.
  Its later failure left the session in an error state. Reconnect now waits for
  that load to retire and starts one fresh load for the latest reconnect, with
  disposal/connection checks before proceeding.
- Final identity audit found a pre-dispatch variant of the duplicate-send race:
  another window can finish retrying while the original attachment is still
  encoding. Minting the RPC submission ID afterward gives the original a second
  identity. The persisted composer ID now travels explicitly through Input,
  the launch-shell pending message, App and SendOptions into the RPC. Independent
  programmatic sends cannot borrow another composer's pending attempt. A new
  two-controller regression failed before this fix
  (`/tmp/three-stage-encoding-baseline.log`).
- The real two-window encoding proof then caught a duplicate optimistic bubble
  and stuck Thinking indicator despite server deduplication. Completed receipt
  lookup now precedes optimistic admission even when another window has cleared
  the checkpoint. Definitively failed receipts still receive a fresh operation
  ID, rather than replaying the same terminal failure indefinitely.

Fail-before-fix unit evidence: `/tmp/three-stage-baseline.log` (draft loss),
`/tmp/three-stage-environment-baseline.log` (generation change during encoding),
and `/tmp/three-stage-reconnect-baseline.log` (stale hydration failure).
The initial concurrent-send browser test exposed duplicate conflict-copy
creation; its trace is retained in `artifacts/three-stage-verified-results/`.
That run passed the other four browser stories, including offline recovery.
The older lifecycle test simulated an unguarded composer failure restoration;
it now exercises the actual guarded callback and durable conflict-copy recovery,
including a follow-up draft and a later broadcast.

432 chat UI unit tests pass. Existing backend environment-retirement/routing
tests pass (30), including refusal to register a stale-generation run; no backend
files were edited in this follow-up. Backend command:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/pytest -p no:cacheprovider tests/unit/core/agents/test_environment_run_retirement.py tests/unit/execution/test_routing.py -q
```

The first final-build run passed both conflict stories, archive/upload and
late-ack recovery, but its new three-tile assertion incorrectly required model
controls to be enabled during all waits. `App.tsx` passes
`disabled={machine.thinking}`: a question keeps the running phase, while the
separate `awaitingApproval` phase is not thinking (`isThinking` explicitly excludes
it). A subsequent assertion incorrectly lumped both waits together as disabled.
The final assertion requires restored values, a disabled question tile, enabled
approval/idle tiles, and visible controls. No product change was made to
accommodate either mistaken test assumption. The other five stories passed in
`artifacts/three-stage-complete-report/index.html`; the corrected tile proof is
run separately to retain those artifacts and avoid repeating unchanged stories.

All six browser stories now have passing final-build results: five in the main
run below and the corrected tile story in its separate rerun. The conflicting
draft proof verifies actual restored attachment bytes in the outgoing RPC and
one transcript copy of each message. The settings story takes only window A
offline while B changes all four settings and sends a message; A restores the
new values and transcript on reconnect. Reviewed conflict-restore, missed-setting
recovery and three-tile offline screenshots.

Exact browser proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/three-stage-complete-report npx playwright test tests/e2e/specs/chat-conflicting-drafts.spec.ts tests/e2e/specs/chat-send-retirement.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts tests/e2e/specs/shared-submission-recovery.spec.ts tests/e2e/specs/shared-session-windows.spec.ts --grep-invert 'a competing approval reply' --project=server-local --output=artifacts/three-stage-complete-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/three-stage-tiles-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts --project=server-local --output=artifacts/three-stage-tiles-results
```

Reports: `artifacts/three-stage-complete-report/index.html` (five passes and the
superseded tile assertion failure), `artifacts/three-stage-tiles-report/index.html`
(corrected tile pass). Results: `artifacts/three-stage-complete-results/` and
`artifacts/three-stage-tiles-results/` (screenshots, videos, full traces).

The first native pass verified archive/upload and attachment recovery; its tile
test exposed a non-actionable programmatic focus during reconnect. Selection
now uses an actionable click and bounded retry across transient disabled states,
retaining the ownership assertions afterward. The new encoding-race fixture also
now scopes its file chooser to its visible composer: portals place it outside
the tile container, and a second window can mount an additional hidden draft
chooser. Neither calibration required a product change.

Both final identity proofs pass, including the new encoding/retry case and the
existing late-acknowledgment/newer-input case. Exact command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/three-stage-encoding-fixed-report npx playwright test tests/e2e/specs/shared-submission-recovery.spec.ts --project=server-local --output=artifacts/three-stage-encoding-fixed-results
```

Report: `artifacts/three-stage-encoding-fixed-report/index.html`.
Results: `artifacts/three-stage-encoding-fixed-results/`.
Seven distinct browser stories now have passing proof. The later identity run
supersedes earlier encoding fixture/product failures; those artifacts remain
available for diagnosis. The two conflict stories also passed again after the
explicit identity plumbing in `artifacts/three-stage-identity-final-results/`.

Final native Electron proof passes all three stories on the final build:
attachment abort/reload/retry, archive during encoding, and three-tile layout
churn/offline/reconnect/reload. Reviewed the native offline-recovery screenshot.
Exact command after `npm run build`:

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/three-stage-native-final-report npx playwright test tests/e2e/specs/chat-send-retirement.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts tests/e2e/specs/chat-attachment-failure.spec.ts --grep 'archiving|isolates three|retains an aborted' --project=electron-local --output=artifacts/three-stage-native-final-results
```

Report: `artifacts/three-stage-native-final-report/index.html`.
Results: `artifacts/three-stage-native-final-results/` (screenshots, videos, traces).
TypeScript, targeted ESLint/Prettier, `git diff --check`, browser and Electron
production builds pass. All confirmed product failures identified in this
follow-up have fixes and regressions; changes remain uncommitted.

Scope limits: local same-origin browser windows share IndexedDB;
different-device draft synchronization is not claimed. Offline transport is
simulated, not a physical laptop suspend/resume or token-expiry test. Environment
replacement during encoding is covered at controller and backend boundaries;
the archive-during-upload story has native UI coverage. Azure remains excluded.

## Submission completion ownership follow-up — complete locally

Requested 2026-09-07: continue the shared-session investigation. Confirmed a
late-completion bug: window A sends, window B recovers that accepted submission
and starts another send, then A's delayed acknowledgment clears B's newer
pending message and attachment recovery record. The new controller unit test
and browser story both failed before the fix. Browser baseline evidence is in
`artifacts/send-owner-baseline-report/index.html` and
`artifacts/send-owner-baseline-results/`.

Fixes:

- Session completion clears only the submission identity it owns, across direct
  runs, queued sends, client responses and receipt recovery.
- Composer attempts have identities too. Late success/error continuations and
  retries cannot clear or restore over a newer pending input.
- The ownership check runs both against in-memory state and inside the atomic
  IndexedDB transaction, protecting windows that missed a broadcast.
- Definitive queue refusal preserves pending input for composer restoration;
  successful completion clears its owned recovery error.

Verification: 422 tests pass across the chat UI directory, including controller
ownership, stale-database completion, late composer success/failure and queue
refusal regressions. TypeScript, targeted ESLint/Prettier, `git diff --check`,
browser production build and Electron production build pass.

Permanent browser story: `tests/e2e/specs/shared-submission-recovery.spec.ts`.
All three visual proofs pass with this exact command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/send-owner-verified-report npx playwright test tests/e2e/specs/shared-submission-recovery.spec.ts tests/e2e/specs/chat-attachment-failure.spec.ts --project=server-local --output=artifacts/send-owner-verified-results
```

Report: `artifacts/send-owner-verified-report/index.html`.
Results: `artifacts/send-owner-verified-results/` (screenshots, videos, traces).
Reviewed the screenshot showing the newer recoverable message after the older
acknowledgment. The test also checks persisted attachment bytes and one copy of
each message in both transcripts. Existing attachment-abort/reload and preview
URL cleanup stories pass unchanged.

Native Electron visual proof passes all three attachment/preview/three-tile
regressions. Reviewed the screenshot of three independently owned tiles after
layout churn, duplicate deliveries, reconnect and reload. Exact command after
`npm run build`:

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/send-owner-electron-report npx playwright test tests/e2e/specs/chat-attachment-failure.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts --project=electron-local --output=artifacts/send-owner-electron-results
```

Report: `artifacts/send-owner-electron-report/index.html`.
Results: `artifacts/send-owner-electron-results/` (screenshots, videos, traces).

This round does not claim simultaneous independent sends, arbitrary conflicting
typing, or submission-time archive/environment-switch coverage. Those remain
next investigation targets, not confirmed bugs. No backend changes were needed;
Azure remains excluded and changes remain uncommitted.

## Shared-session multi-window follow-up — complete locally

Requested 2026-09-07: investigate competing clients of one session, not just
separate-session tiles. No Azure or shared user state. Existing dirty-tree
changes are preserved; targeted backend edits were approved separately.

Confirmed findings and fixes:

- Launcher ignored `ui.set_session_state`, so a model change in one window left
  another window stale. The session controller now applies model, reasoning and
  reviewer notifications through its owner-specific panel revisions. Missing
  fields do not erase existing values; invalid reviewer values are ignored.
- Omniagents reviewer setters did not notify other clients, and session-state
  notifications omitted those fields. Successful approval/workflow changes now
  publish the same session-state notification as model changes; refusals remain
  silent. No new RPC or transport was added.
- A live selection update during model-catalog loading invalidated the entire
  result, losing model options and unrelated settings. Reads now reconcile each
  field independently while retaining the newer selection.
- Delayed mutation replies overwrote newer remote selections. Each model,
  reasoning and reviewer mutation now fences its result against newer panel
  updates, rather than treating response arrival order as mutation order.
- An explicit null model override means the catalog default, not an indefinitely
  loading model. The controls now display/select that default correctly.

Failing evidence: `shared-session-baseline-unrestricted-{report,results}` shows
the second window missing a model change. `shared-session-delayed-reply-baseline-
{report,results}` shows an old model reply reverting a newer notification.
The catalog-race unit regression also failed before its fix. Separate fixture
calibrations had an unsupported deterministic prompt and an overly exact menu
selector; those failures are not product findings.

New permanent stories are in `tests/e2e/specs/shared-session-windows.spec.ts`:
remote settings changes and delayed replies across four controls; competing
approval replies, subsequent shared transcript updates, and remote archive.
The competing approval/archive scenario has passed without a product change.
This follow-up does not yet claim coverage for simultaneous independent sends,
large histories, token expiry or sleep/wake.

Final browser visual proof passes all three stories, including the existing
concurrent-add/stale-reorder story. The settings story holds an accepted RPC
reply in window A, changes the same setting from window B, then releases A's
older reply; both windows retain the newer choice. This runs for model,
reasoning, approval reviewer and workflow reviewer. Exact command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/shared-session-verified-report npx playwright test tests/e2e/specs/shared-session-windows.spec.ts tests/e2e/specs/chat-window-concurrency.spec.ts --project=server-local --output=artifacts/shared-session-verified-results
```

Report: `artifacts/shared-session-verified-report/index.html`.
Results: `artifacts/shared-session-verified-results/` (screenshots, videos and
full traces). The first-window and second-window final screenshots were reviewed.
Three new frontend unit regressions cover notification ownership/field validity,
catalog loading during remote changes and default-model display. The full chat
UI run passes 458 tests. Backend model/reviewer/server-function tests pass 46
tests, including both added reviewer-notification regressions.

Native Electron three-tile regression proof also passes (1 test). Exact command,
after the successful Electron build and native ABI restoration:

```bash
npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/shared-session-electron-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts --project=electron-local --output=artifacts/shared-session-electron-results
```

Report: `artifacts/shared-session-electron-report/index.html`.
Results: `artifacts/shared-session-electron-results/`.
TypeScript, targeted ESLint/Prettier, backend Black and both worktrees'
`git diff --check` pass. Browser/Electron production builds pass. No known
product failure identified in this round remains open. Simultaneous independent
sends/conflicting drafts are the next untested boundary, not a claimed pass.
Changes remain uncommitted; Azure remains excluded.

## Sustained lifecycle audit — complete locally

Follow-up requested after the earlier stages were closed. Add an opt-in permanent
`chat-lifecycle-soak.spec.ts`, calibrate it, then run one isolated launcher profile
for at least 30 minutes. No Azure, real model billing or shared user data.

Each cycle combines plans/artifacts, a pending question, a pending approval,
uploaded drafts, duplicate notifications, reconnect/reload, model changes,
archive/restore, a fresh restored response, and a live switch between two local
host profiles. Periodic backend-only SIGKILL exercises recovery. Assertions cover
exactly one accepted user row, owner-specific content and drafts, terminal
approval state, drained cleanup jobs and zero live retired environments.

Calibration identified an **incorrect test assumption**, not an orphan: the
targetless product-management consumer intentionally keeps its shared host alive
after the last chat closes. The resource probe therefore retains private host
references after journal removal and checks authoritative environment states,
not blanket process death. Actual backend crashes still require the old host
processes to exit. Probe credentials never enter page state or report payloads.

Resource samples and visual proofs are attached to the Playwright report.
Confirmed product failures have focused regressions; failing calibrations are
not counted as completed soak time.

Same-page calibration found a real backend-restart failure: previously running
tiles retained stale runtime status and disabled composers indefinitely. Normal
status polling skipped `running` entries. Reconnect now reconciles cached process
statuses with the launcher; a missing runtime explicitly re-enters the launch
machine with its original conversation/workspace identity. Socket outages alone
do not relaunch, and stale reconciliation replies cannot overwrite newer pushes,
cleared statuses or a later connection. Intentionally stopped/unused surfaces
do not auto-start.

The independent product-management provider also retained its dead runtime URL.
It now reacquires its targetless connection on launcher reconnect, replacing the
client/repository only when the connection changes. Generation checks reject
superseded bootstrap replies, and effect cleanup removes the reconnect listener.

The backend-only fixture previously closed and replaced the browser context,
which erased IndexedDB and concealed the same-page recovery gap. It now keeps
the original page, browser context and local model endpoint alive. Calibration
v6 is the failing same-page proof; subsequent runs verify the fixes. The separate
short crash regression also requires the same page and a fresh assistant reply,
without navigation or reload. A delayed initial status seed is also fenced
against newer pushed endpoints. The final combined frontend regression run
passes 512 tests; the sustained proof below now passes.

Calibration v7 recovered and produced a fresh reply, but its history count
revealed another fixture flaw: the simulated model reused a constant response
and assistant-message ID across requests. The runtime correlates messages by
provider ID, so the model now emits unique IDs per call and stable IDs within
each stream (covered by a permanent unit test). The crash also waits for the
preceding run to finish, rather than treating a visible partial response as a
durable completed run. Calibration v8 passed, including same-page restart,
three retained assistant responses, preserved draft/upload and complete runtime
retirement (87,483 ms measured cycle). The full 30-minute UI run began afterward;
no failed or short calibration time contributes to its duration.

The first intended 30-minute run was **interrupted after finding a real resource
leak**; its artifacts are retained under `chat-lifecycle-soak-30m-{report,results}`
and do not constitute a completed soak. Three completed cycles left 3, 6, then 9
session MCP subprocesses alive on the shared host. Idle file descriptors rose
26 → 35 → 44 despite zero active environment descriptors and no cleanup jobs.
Those workers were owned only by the session's explicit backend archive path;
launcher-local archival retired the environment without closing them.

Environment ownership now includes auxiliary resource tasks, admitted under the
same lease/generation fence as runs. Retirement joins runs first, then their
resource workers, then closes the environment. MCP startup is coalesced per
session/lease; changing leases closes the old worker before creating another.
Each worker owns both entry and exit of its AnyIO context. Timeouts retain a
STOPPING environment for retry, and failed resource owners remain visible rather
than falsely completing cleanup. Browser resource probes now also require zero
child workers after retirement, and backend-crash checks include the old workers
as well as their host PID. The stronger two-cycle calibration passed: zero idle
workers in both cycles, 17 idle descriptors after normal retirement and 19 after
same-page crash recovery.

The second intended soak (`chat-lifecycle-soak-fixed-30m-{report,results}`)
passed six cycles, keeping zero idle workers and 17 descriptors, then **failed
its socket-baseline assertion after cycle seven's reload** (6 sockets versus a
3-socket baseline and allowance of 2). It is retained as failure evidence, not
counted as completed proof. Retired pooled RPC clients were only disconnected,
not permanently disposed, allowing late asynchronous work to reconnect them.
Pool/product-management retirement now disposes their clients. Chat bootstrap
also owns an abortable realtime capability probe; failed/aborted connects close
the temporary socket. Realtime disconnection settles an in-flight socket connect
and clears its deadline immediately. Targeted regressions cover these lifetime
boundaries. Calibration v10 passed but its socket diagnostics still showed
initialized-only connections, so the next long run was interrupted early to
close the underlying ticket race. An in-flight authentication ticket could
resolve after client disposal and create a new socket; an old failed attempt
could also close a replacement because cleanup used the mutable current socket.
Connection attempts now have explicit ownership, abortable ticket fetches,
per-attempt socket cleanup, and synchronous coalescing before machine callbacks.
Focused regressions verify late ticket results/failures and reentrant connects.
Calibration v11 passed two cycles, including page reload and same-page backend
crash recovery, in 166,504 ms of measured workload. Both cycles returned to two
sockets, 16 host descriptors, zero MCP workers and zero active environments.
The initialized-only orphan connections are gone.

The next run (`chat-lifecycle-soak-verified-30m-{report,results}`) completed all
23 workload cycles in 1,807,015 ms, including three reloads and two same-page
backend crashes. Every sample returned to two sockets, 16 descriptors, zero MCP
workers, zero active environments and zero cleanup jobs. **Its overall report
failed during trace finalization**, which exceeded Playwright's separate
120-second project timeout; it is not recorded as a passing E2E run. Playwright
uses the project timeout for this slot even when the test overrides its timeout.
Opt-in soak runs now allow ten minutes for finalization and omit per-action DOM
snapshots/screenshots from their trace, retaining actions, explicit owner
screenshots and full video. Focused proof specs retain full DOM snapshots.
The fresh full-duration run **passed**, including teardown/report finalization:
24 complete cycles in 1,868,977 ms (31 minutes 9 seconds), three page reloads and
two backend-only crashes. Every idle sample had exactly two sockets and 16 host
descriptors, with zero MCP children, zero active chat environments and zero
cleanup jobs. Idle host RSS ranged from 185,942,016 to 213,684,224 bytes across
restarts; the browser's coarse heap estimate was 97,400,000 bytes. These are
observations, not an exhaustive heap-retention proof. The intentional shared
product-management host remained alive. No Azure verification was performed.

Exact passing visual-proof command (browser and Electron bundles built first):

```bash
OMNI_CHAT_SOAK_MS=1800000 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-lifecycle-soak-complete-30m-report npx playwright test tests/e2e/specs/chat-lifecycle-soak.spec.ts --project=server-local --output=artifacts/chat-lifecycle-soak-complete-30m-results
```

Report: `artifacts/chat-lifecycle-soak-complete-30m-report/index.html`.
Results (owner screenshots, full video, lightweight action trace, JSON resource
samples): `artifacts/chat-lifecycle-soak-complete-30m-results/`.
Earlier interrupted/failed reports remain preserved and are not passing proof.

Focused browser visual proofs also pass (2 tests): same-page backend crash and
three-tile interaction, including actually answering the pending question and
approval. Command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-lifecycle-final-server-report npx playwright test tests/e2e/specs/chat-backend-crash.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts --project=server-local --output=artifacts/chat-lifecycle-final-server-results
```

Report: `artifacts/chat-lifecycle-final-server-report/index.html`.
Results: `artifacts/chat-lifecycle-final-server-results/`.

Native Electron visual proofs pass (4 tests): archive isolation, failed-stop
retry, failed-stop retry after reload, and the three-tile interaction story.
The native dependency was restored to Electron's ABI with `npm run rebuild`.
The existing display was used (this machine has no `xvfb-run`). Passing command:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-lifecycle-final-electron-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --output=artifacts/chat-lifecycle-final-electron-results
```

Report: `artifacts/chat-lifecycle-final-electron-report/index.html`.
Results: `artifacts/chat-lifecycle-final-electron-results/`.

Final checks: 512 frontend/model-fixture tests pass; TypeScript, targeted ESLint,
targeted Prettier and `git diff --check` pass. Browser and Electron production
bundles build successfully. Backend checks pass 273 tests with nine PostgreSQL
history tests skipped as noted below. No known product failure from this audit
remains open; this is not a claim that every possible chat workload is bug-free.
Azure remains excluded by request. All changes remain uncommitted, preserving
the pre-existing worktree edits.

The independent socket soak completed successfully: 1,800,024 ms, 895 cycles,
17,900 created connections and 17,900 cleaned. Each cycle returned the handler's
socket/session/cleanup collections to zero. Process RSS was 103,870,464 bytes at
baseline and 117,116,928 at completion; these are unforced-GC observations, not a
proof of bounded heap usage for every workload. Command:

```bash
OMNI_CONNECTION_SOAK_MS=1800000 npx vitest run src/server/connection-soak.test.ts
```

Final backend regressions currently pass 273 tests, including six added MCP
retirement/race tests. Nine PostgreSQL history tests remain explicitly skipped
without `OMNIAGENTS_TEST_PG_URL`. No PostgreSQL implementation changed here.

## Autonomous continuation — launcher recovery and backend run retirement

The previously open archive-approval finding is closed. The implementation
stages recorded in this audit are complete; the verification exclusions below
remain explicit, rather than being treated as tested infrastructure.

The launcher-side durable cleanup work is implemented and verified locally:

- Tab removal and its cleanup job are committed in the same settings patch /
  PostgreSQL transaction. Failed cleanup and acknowledgements retain the job;
  retries share a per-tab executor. Stale replicas acknowledge individual jobs
  without overwriting the rest of the queue.
- Private, mode-0600 runtime journals record host/workspace identity and control
  credentials before materialization. Credentials never enter renderer settings.
  Delegated compute session identities are also journaled after allocation.
- Startup recovers abandoned runtimes, including inactive chats. On Linux,
  recorded process-start identity fences orphan termination against PID reuse.
  An unresponsive orphan's control socket is not required to terminate the
  verified old process. Recovery and job draining retry in the background.
- Runtime ownership is checked before launches; closed IDs cannot be resurrected
  by a stale window after restart. Rebuild and profile-switch operations join
  the per-consumer materialization queue so stop waits for their result. A
  replacement-host rebuild now awaits the full consumer configuration path.
- Failed local/remote shutdowns no longer report success or drop the retry
  identity. Local SIGKILL completion waits for observed child exit. Failed JSON
  persistence no longer publishes an uncommitted removal in memory.
- PostgreSQL discovers principals with pending jobs without waiting for them to
  reconnect. Jobs belonging to another live runtime owner remain deferred;
  missing provider access or unverified ownership never licenses deletion.

Verification completed in this continuation:

- 260 targeted regressions passed (`/tmp/chat-cleanup-final-regressions.log`).
- 9 PostgreSQL tests passed against an isolated database, including atomic job
  creation, stale-cache acknowledgement and launch-after-close rejection
  (`/tmp/chat-cleanup-final-pg.log`).
- Four real subprocess SIGKILL checkpoints exercise commit, stop, deletion and
  acknowledgement. These use simulated resource files with the production
  reducer, JSON store and cleanup executor, not actual runtime processes.
- The separate real browser/server test kills **only the launcher backend**,
  leaves its agent host alive, then proves the old host exits and the original
  conversation can be reopened, used and archived with no remaining job.
- Three final browser stories passed, and three native Electron stories passed.
  Earlier browser stop/reload stories also passed. TypeScript, targeted ESLint,
  server/Electron builds and whitespace checks passed.

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-cleanup-final-server-report npx playwright test tests/e2e/specs/chat-backend-crash.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/chat-window-concurrency.spec.ts --project=server-local --output=artifacts/chat-cleanup-final-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-cleanup-electron-report npx playwright test tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --output=artifacts/chat-cleanup-electron-results
```

**Fixed after explicit backend-edit approval:** reopening an archived chat could
restore its still-pending approval. `AgentService.agent_host_stop_environment`
previously stopped the execution environment without cancelling its runs. The old native
proof image `artifacts/chat-cleanup-electron-results/chat-archive-lifecycle-arc-e6c8b-luding-a-lost-archive-reply-electron-local/archived-tile-runtime-retired-while-neighbor-awaits-approval.png`
shows this: both A's reopened approval and B's legitimate approval remained.
That earlier archive spec did **not** assert removal of A's approval; its passing
result did not prove the missing behavior.

The backend now registers run tasks against their exact environment lease under
the same lock that publishes STOPPING. Starts prepared against a stopped or
superseded lease cannot publish a task. Retirement cancels the registered runs
and awaits their cleanup before closing the environment, without touching runs
in neighboring environments. Concurrent stop callers share the operation;
disconnecting one caller cannot abort it. Unconfirmed cancellation leaves the
environment STOPPING and retryable, never falsely retired.

Session cancellation now resolves an exact run task, not the session's mutable
current task. Concurrent UI/environment cancellation shares one attempt so a
second cancellation cannot interrupt the worker's awaited cleanup; caller
disconnect also leaves that attempt running. Cancellation timeouts retain the task for retry. Run-end request
cleanup keeps the session occupied until old requests are resolved, preventing
cleanup from erasing a newer run's controls.

New backend regressions cover approval cleanup and neighboring runs, late starts,
stale generations, exact run identity, cleanup ordering, cancellation timeout and
retry, caller disconnect, and session reuse during cleanup. The permanent
archive story now asserts that restored A has neither an approval nor Stop,
that B's approval remains actionable, and that A can run a fresh message.

Backend follow-up verification:

- 259 backend tests passed, including 10 new retirement/race regressions.
  Nine PostgreSQL-only history tests were skipped because
  `OMNIAGENTS_TEST_PG_URL` was not configured for this run. No PostgreSQL backend
  history implementation was changed in this follow-up.
- Python Black, launcher TypeScript, targeted ESLint/Prettier and whitespace
  checks passed.
- Native archive/restore and stop-retry proofs passed (3 stories), including a
  successful new response in restored A. Screenshots were visually inspected:
  A has no stale approval while B awaits its own, and both subsequently respond.
- Browser proofs passed (3 stories): archive/restore, backend-only crash
  recovery, and three mixed tiles with plans/artifacts, approvals, questions,
  uploaded drafts, duplicate events, reordering, reconnects and reload.
- Final native rerun also passed all 3 stories against the completed backend
  changes (`/tmp/chat-approval-retirement-electron.log`). Electron's native
  dependencies were restored with `npm run rebuild` before that run.

Backend command (from `../omniagents`):

```bash
.venv/bin/pytest -q tests/unit/core/agents/test_environment_run_retirement.py tests/unit/core/session tests/unit/execution tests/unit/core/runtime/test_environment_provisioner.py tests/unit/core/agents/test_service_environment_runtime.py tests/unit/core/agents/test_service_start_run.py tests/unit/core/agents/test_client_request_lifecycle.py tests/unit/core/agents/test_approval_identity.py tests/unit/core/agents/test_service_enqueue.py
```

Visual proof commands (reports contain screenshots, traces and videos):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-approval-retirement-electron-report npx playwright test tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --output=artifacts/chat-approval-retirement-electron-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-approval-retirement-server-report npx playwright test tests/e2e/specs/chat-archive-lifecycle.spec.ts tests/e2e/specs/chat-backend-crash.spec.ts tests/e2e/specs/three-tile-adversarial.spec.ts --project=server-local --output=artifacts/chat-approval-retirement-server-results
```

Azure remains skipped. Verification here is Linux-local; no deployed routing,
cross-machine recovery access or non-Linux process-reaping claim is made.

## Earlier backend-crash cleanup prerequisites

At the start of the continuation, durable cleanup/restart was not complete. Investigation
found failure paths that would make a naive outbox worker acknowledge unfinished
cleanup. The following prerequisites were fixed first:

- `ProcessManager` retains the detached host/environment shutdown target after
  failure. A retry reaches that exact target instead of finding an empty map and
  returning success. New tabs cannot attach to a host whose final consumer is
  stopping; starts, rebuilds and profile switches reject an already-stopping
  consumer. Application shutdown also includes detached failed-stop hosts.
- When another tile is shutting down the shared host, an environment-stop retry
  waits for that host shutdown rather than treating its closed control client as
  proof of process exit.
- Docker removal failures retain the durable sandbox ownership record. An
  ambiguous reply is accepted only after a successful daemon query confirms
  absence. Corrupt records, inaccessible Docker, and replacement ownership
  records are not silently erased. File removal errors propagate.

Verification: 137 tests across `agent-process`, `agent-host-manager`,
`process-manager`, `sandbox-state`, `chat-removal`, `docker-orphan-cleanup`, and
`chat-commands`. Command:

```bash
npx vitest run src/main/agent-process.test.ts src/main/agent-host-manager.test.ts src/main/process-manager.test.ts src/main/sandbox-state.test.ts src/main/chat-removal.test.ts src/main/docker-orphan-cleanup.test.ts src/shared/chat-commands.test.ts
```

Log: `/tmp/chat-cleanup-retry-broad.log`. These are injected failure/race tests
with real temporary ownership files, **not** actual backend SIGKILL or new UI
proof. Earlier browser/native proofs below predate this stage.

Original remaining plan (superseded by the continuation status above):

1. Persist an authoritative cleanup outbox atomically with tab removal (JSON
   patch / PostgreSQL row transaction). Completion must update the individual
   job against current authority, never replace a stale jobs snapshot.
2. Persist/reconcile runtime ownership so restart recovery can prove which host,
   environment generation and workspace it is retiring. `ProcessManager` maps
   and retired-tab fences are currently memory-only; an empty new manager is
   not proof that an old host child or remote runtime has exited. Preserve jobs
   when ownership cannot be established. Scope workers and claims per principal
   and team; account for replicas and tenants that have not reconnected yet.
3. Drain/retry jobs on restart with current workspace-ownership guards. Do not
   automatically feed old jobs into `cleanupRemovedChat` before stage 2: that
   could turn an unknown runtime into a successful no-op stop and delete its
   workspace while it is still live.
4. Actual backend kill-point tests at commit, stop, deletion and acknowledgement;
   competing-window send/archive, reopen/cleanup and approval/stop user stories
   in browser and Electron. Keep Azure verification skipped.

## Baseline

Earlier fixes and evidence: `artifacts/chat-review/adversarial-fixes.md` and
`artifacts/chat-review/adversarial-discovery.md`. Those cover launcher socket
revocation, document-pinned team identity and connection-bound reverse-RPC replies.
Existing dirty worktree changes predate this staged audit and must be preserved.

## Autonomous follow-up: attachments, renderer retention, close/crash races

Stages requested after the cancellation pass: investigate and fix each area,
then verify with focused tests and browser/native user stories. Azure remains
skipped; no shared infrastructure or user profiles are modified.

1. Attachment failures: aborted FileReader operations now reject rather than
   leaving Send pending forever. Temporary IndexedDB-open failures no longer
   poison the cached connection; a later save can retry. Broadcast updates read
   only the changed draft, avoiding cloning every retained attachment.
2. Renderer retention: image-preview blob URLs now belong to the mounted image
   and are revoked on replacement/removal/unmount. SessionRegistry evicts
   unmounted idle controllers after five minutes, while retaining mounted tiles,
   active runs, submissions, approvals, queued messages and other pending work.
   A 1000-closed-chat regression keeps one tile mounted and verifies all 1000
   closed idle registrations are released without disconnecting that tile.
3. Close/crash races: main/server now perform runtime retirement and guarded
   snapshot deletion inside the authoritative archive/remove command before
   replying. Renderer continuations no longer own these remote operations.
   Local terminal/status caches are also cleared when another window removes
   a tab. Failed terminal disposal cannot skip runtime shutdown; failed shutdown
   cannot trigger snapshot deletion. ProcessManager fences late starts/rebuilds
   for retired tab IDs, while reopening creates a different consumer ID.
   Stale routine-tab refreshes also receive fresh tab/snapshot identities when
   the former tab no longer exists; they cannot resurrect the retired ID.

Verification: 195 focused tests passed, including 1000 closed idle controller
lifecycles alongside a retained tile, aborted file reads, storage retry and
cross-window reads, cleanup failure ordering, late starts after retirement, and
stale routine reopening. Initial browser archive diagnostic used an invalid
string RPC ID; that run was interrupted and the probe corrected to the
transport's numeric ID contract. The final six UI stories passed:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-next-final-server-report npx playwright test tests/e2e/specs/chat-attachment-failure.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=server-local --output=artifacts/chat-next-final-server-results
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-next-final-electron-report npx playwright test tests/e2e/specs/chat-attachment-failure.spec.ts tests/e2e/specs/chat-archive-lifecycle.spec.ts --project=electron-local --output=artifacts/chat-next-final-electron-results
```

Each mode passed all three stories. Reports are the corresponding
`*-report/index.html`; screenshots, traces and videos are in the `*-results/`
directories above. Inspected attachment failure/retry screenshots confirm the
retained filename and draft, visible retry error, then one submitted attachment
and an assistant response. The archive test verifies the removed runtime is
uninitialized after the reply is lost and its neighbor can still complete.

Logs: `/tmp/chat-next-final-unit.log`, `/tmp/chat-next-tsc-final.log`,
`/tmp/chat-next-eslint-final.log`, `/tmp/chat-next-prettier-final.log`,
`/tmp/chat-next-server-build-final.log`, `/tmp/chat-next-electron-build-final.log`,
`/tmp/chat-next-final-server-e2e.log`, `/tmp/chat-next-final-electron-e2e.log`.

All three local stages are complete. Final TypeScript, targeted ESLint,
Prettier, server/browser build, Electron build, and whitespace checks passed.
A TypeScript run overlapping package rebuilds briefly saw missing generated
declarations; rerunning after builds finished passed without source changes.
Electron's native dependency ABI was restored (`npm run rebuild`), and owned
test application processes exited. No user data was removed and nothing was
staged, committed, or deployed.

Boundary: this moves cleanup across the renderer-crash boundary; it is not a
durable multi-replica cleanup outbox or a claim about process placement after a
backend crash. Cleanup failures propagate rather than being silently ignored.

## Follow-up: cancellation and conflicting window actions

- Fixed: stop RPC failures were swallowed after entering `stopping`, leaving
  the view stuck. `ConversationSession.stopRun()` now owns cancellation,
  coalesces requests for the same run, restores a retryable state on failure,
  and reports the failure in that conversation. Ticket/routine bridges use the
  same operation and propagate failures rather than reporting success.
- Fixed: a late stop acknowledgement in a ticket/routine bridge could apply a
  state-only stop to a newer run. The session operation captures the original
  run ID; late success/failure does not transition a replacement run.
- Fixed: the composer hid Stop during pending approval. Approval waiting is
  now treated as active work by the composer (stop/queue controls), without
  changing the transcript's processing-spinner semantics.
- Fixed: successful cancellation left pending approval cards clickable.
  Live and recovered approval cards now retain their run ownership, and a
  matching run end retires that run's cards without removing another run's
  approval. The transcript adapter now forwards `run_id` on run end and
  the machine rejects an older run's end while a newer run is active.
- Fixed: reopening from a stale window could restore an old workspace/profile
  and overwrite a newer title. Reopen now resolves indexed metadata at the
  authoritative command boundary, retaining caller metadata only for sessions
  not yet indexed.
- Verified by reducer regression: a late title update preserves `archivedAt`
  and does not recreate the removed tile. Archive is retained history, not
  permanent server-session deletion; this does not claim a hard-delete proof.
- Next audit areas remain attachment failures, long-lived renderer retention,
  and broader close/reopen/crash interleavings. These are coverage targets,
  not confirmed unresolved defects.

The first browser proof exposed the missing Stop control; the second browser
and native proofs exposed approval cards surviving successful cancellation.
Those failures are retained in `artifacts/chat-stop-server-results/`,
`artifacts/chat-stop-final-server-results/`, and
`artifacts/chat-stop-electron-results/`; they are not passing proof artifacts.

The first reload variants also had test assumptions to correct: boot can open
a fresh tile, so the test must reopen the retained chat and scope the editable
composer assertion to its original tile. The superseded browser reload run was
interrupted once this was identified; it is not a product failure or passing proof.
The browser fixture starts in Focus, unlike the native fixture's Spaces layout;
the final shared story explicitly selects Spaces before using tile selectors.

Final local checks: 163 targeted tests; TypeScript, targeted ESLint, Prettier,
server/browser build, Electron build, and `git diff --check` passed. Logs:
`/tmp/chat-stop-tests-final.log`, `/tmp/chat-stop-tsc-final.log`,
`/tmp/chat-stop-eslint-final.log`, `/tmp/chat-stop-prettier.log`,
`/tmp/chat-stop-build-final.log`, `/tmp/chat-stop-electron-build-final.log`.

Native proof: both live and reloaded approval stop/retry stories passed in the
final shared-spec run (2 passed, 36.0 seconds):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-stop-final-electron-report npx playwright test tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --output=artifacts/chat-stop-final-electron-results
```

Report: `artifacts/chat-stop-final-electron-report/index.html`.
Screenshots, videos and traces: `artifacts/chat-stop-final-electron-results/`.
Browser proof: both stories passed (2 passed, 42.0 seconds):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/chat-stop-passing-browser-report npx playwright test tests/e2e/specs/chat-stop-retry.spec.ts --project=server-local --output=artifacts/chat-stop-passing-browser-results
```

Report: `artifacts/chat-stop-passing-browser-report/index.html`.
Screenshots, videos and traces: `artifacts/chat-stop-passing-browser-results/`.
Inspected native successful-stop and browser reloaded failed-stop screenshots:
the controls/error remain in the original tile, and stopped approvals disappear.
The attempted alternate-port run used `E2E_SERVER_URL`, which means attach to
an already-running server (not launch on that port); it was interrupted and is
not verification evidence. All passing browser runs used the normal fixture.

## Findings and evidence

Updated as each stage is completed.

### Stage 1

- `/ws/chat`: buffer early frames with a size limit; do not subscribe after a
  disconnected startup; fresh membership checks before dispatch and delivery;
  reject JSON null without an unhandled rejection.
- Runtime and launcher credentials now have signed, distinct purposes. Old
  unscoped tokens fail closed: launchers fetch a new token on reconnect; existing
  sandbox runtimes must restart to obtain scoped credentials during rollout.
- HTTP MCP checks current human membership or team resident identity. Credential
  refresh checks the human's current membership, including resident callbacks.
- Internal proxy registration includes team/principal/upstream ownership and an
  opaque HMAC-derived path, avoiding globally shared `chat`/`management` routes.
  Cloud membership gates upgrades, requests and streamed/frame delivery.
- Laptop relays now require a machine/session/port capability; incoming tunnel
  frames must come from the original laptop socket. Late open completion closes
  the orphaned laptop half. Capabilities are revoked on session release.
- Initial targeted regression run: 118 tests passed (`/tmp/staged-auth-tests.log`).
  Later additions and final integration still require verification.

### Stages 2–3

- Browser lost-acknowledgement, failed recovery snapshot, and stale second-window
  stories passed (3 stories). Existing replay/controller regressions passed with
  the authorization tests (216 tests in `/tmp/staged-unit.log`). Server durable
  submission receipt regressions: 4 passed (`/tmp/staged-submission-python.log`).
- Three-tile story combines A's plan/artifact and delayed response, B's pending
  question, C's approval, three uploaded drafts, seeded layout/reorder/reconnect
  actions, deliberately duplicated/delayed events and reload.
- Initial three-tile failure was an incorrect test assumption: calling focus()
  on a disabled reconnecting composer has no effect. Event logs confirmed no
  B focus event occurred. Test now waits for editable and asserts actual focus.
  No product patch was made for that failure. Corrected proof passed in browser
  and native Electron, including an additional browser run with per-owner PNGs.

### Stage 4

`createPgListener` previously only logged disconnects; it did not reconnect.
It now reconnects with bounded backoff, re-subscribes before refreshing cached
state, and stops cleanly. Managers reconcile all loaded team/principal caches on
reconnect and every 30 seconds to repair silently missed notifications.

Real disposable PostgreSQL test terminates the listener backend, writes settings
during the outage, proves cache recovery and subsequent notifications, and checks
that stopping leaves no listener connection. Seven PG tests passed, including
the existing concurrency/persistence regressions (`/tmp/staged-pg-tests.log`).

### Stage 6

Actual launcher replicas behind a local round-robin HTTP/WebSocket edge passed
six reconnects preserving acknowledged chat state and a second identity with no
access to those tabs. The simulated edge rejects missing identity and strips a
spoofed principal header. Prior concurrent writes, SIGKILL recovery and revoked
member checks also passed (`/tmp/staged-replicas.log`).

This is **not** verification of Azure EasyAuth itself or a deployed load balancer.
No authorized deployment was supplied; no cloud infrastructure was changed.

## Final verification (2026-09-06)

- **260 targeted launcher tests passed**, including controller/replay/transport,
  authorization/proxy/tunnel, and WSL token minting. Log: `/tmp/staged-unit-final.log`.
- **Full server suite: 154 passed**, 8 opt-in PG/soak tests skipped in the default
  run and executed separately. Log: `/tmp/staged-server-suite-final.log`.
  A pre-existing chat-WS fixture intermittently connected to the wrong ephemeral
  localhost listener; explicitly binding the IPv4 address used by its client
  corrected that test setup.
- **7 real PostgreSQL tests passed** and the actual-process replica/edge audit
  passed again. Logs: `/tmp/staged-pg-tests.log`, `/tmp/staged-replicas-final.log`.
- **4 Python submission receipt tests passed**, read-only verification of the
  existing server changes. No omniagents source files were changed in this audit.
- **1,000 three-session controller lifecycles / 3,000 registrations** returned
  router listener counts to zero after every owner teardown.
- **Ten-minute real WebSocket soak passed:** 601,847 ms, 299 cycles, 5,980
  document sockets created and 5,980 cleaned. Active/persistent socket maps and
  cleanup jobs returned to zero each cycle. RSS changed from ~103 MB to ~112 MB;
  this is observational, not a proof of flat memory usage over hours. Log:
  `/tmp/staged-soak.log`.
- **Four browser stories and six native Electron stories passed** (some browser
  stories were repeated). The native run skips the intentionally browser-only
  stale-second-window story, which passed in browser mode.
- Production server/browser and Electron builds, TypeScript, targeted ESLint,
  formatting and diff-whitespace checks passed. Final build logs:
  `/tmp/staged-server-final-build.log`, `/tmp/staged-electron-final-build.log`.

### Visual proof commands and artifacts

```bash
# Lost acknowledgements / failed snapshot / stale second window:
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/staged-audit-server-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts tests/e2e/specs/chat-lifecycle.spec.ts --grep 'three mixed|accepted send' --project=server-local --output=artifacts/staged-audit-server-results

# Corrected three-tile story, including screenshots of each owner:
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/staged-three-final-server-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts --project=server-local --output=artifacts/staged-three-final-server-results

npm run rebuild
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/staged-native-report npx playwright test tests/e2e/specs/three-tile-adversarial.spec.ts tests/e2e/specs/chat-lifecycle.spec.ts tests/e2e/specs/tile-pending-recovery.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --grep 'three mixed|accepted send|recovers two pending|generated plans' --project=electron-local --output=artifacts/staged-native-results

OMNI_CONNECTION_SOAK_MS=600000 npx vitest run src/server/connection-soak.test.ts
OMNI_TEST_SETTINGS_PG_URL=<disposable-admin-postgres-url> npx vitest run src/server/pg-listener-recovery.test.ts src/server/composite-settings-store.pg.test.ts
OMNI_TEST_SETTINGS_PG_URL=<disposable-admin-postgres-url> npx vite-node --config vitest.config.ts artifacts/chat-review/replica-adversarial.audit.ts
```

Open `artifacts/staged-three-final-server-report/index.html` and
`artifacts/staged-native-report/index.html` for current passing visual evidence.
The initial `staged-audit-server-report` also retains the historical failed
focus assumption; it is not the final three-tile result. Per-owner browser
screenshots and native approval screenshots were inspected.

### Rollout and remaining limits

- Scoped runtime tokens deliberately reject pre-change, unscoped credentials.
  Reconnect launchers and restart existing sandbox runtimes during rollout.
- Relay profiles now carry scoped capabilities; recreate existing host-bridge
  sessions during rollout. Preparers also verify the machine's principal owner.
- Proxy paths are bearer capabilities: do not publish them. Request logging
  redacts capability/token values; scoped registrations expire when unused.
- Revocation checks prevent subsequent dispatch/delivery, not rollback of an
  operation already accepted. Shared residents use their enabled roster identity;
  human credential refresh remains tied to human membership.
- Local edge coverage tests launcher RPC reconnection and identity isolation,
  not Azure EasyAuth, deployed routing affinity, or cross-replica runtime placement.
- No files were staged or committed. Existing user changes were preserved.
- Cleanup: the owned `omni-staged-audit-20260906` container and its disposable
  database volume were removed after verification. That test-only data is not
  recoverable; no user database was touched. Native dependency ABI was restored
  for Electron, and no verification app processes remain running.

## Durable queue continuation — September 7, 2026

The pending-message crash boundary is now implemented across omniagents and
launcher. Queue acceptance and the retry receipt commit together in SQLite or
PostgreSQL. Pending notifications are durable too, and batching transfers them
into the inbox atomically. Reopening a session resumes unclaimed commands.

Claims are not leases. A process crash after dispatch leaves an explicit
`dispatch_uncertain` item, does not resend it, and pauses subsequent queued work.
The launcher uses the existing Card/Alert components to show that state, with
cancellation disabled. A proven start rejection stays visible and cancellable
without blocking subsequent work. Completed canonical append/turn evidence
settles claims. Queue refresh respects a thread archived by another writer.

Verification in this continuation:

- Backend session/runtime/conversation/agent/replay suite: 1,123 passed before
  three additional service regressions; the expanded enqueue suite: 26 passed.
- PostgreSQL domain/history suite: 114 passed, including shared inbox tests for
  concurrent acceptance, exclusive claims, rollback and notification promotion.
- Process-death tests cover a kill within acceptance, after acceptance and
  after claim, in addition to the existing history/context transaction cases.
  The final combined enqueue/crash run passed all 44 tests.
- Launcher session/queue component suite: 74 passed. TypeScript, targeted
  ESLint, Prettier, Python formatting and whitespace checks passed; production
  server/browser build completed.

The first UI proof attempt exposed two test assumptions, not proof of successful
recovery: Focus mode opens a fresh chat at startup, and the mock model suppressed
all approvals after its first fixed call ID. The permanent test now targets the
saved tile by its stable column identity in Spaces and gives the queued approval
its own deterministic identity. It also checks that the fresh neighboring tile
receives neither the recovered command nor its uncertainty warning. The second
attempt recovered correctly after reopening, then failed after the additional
page reload opened a fresh Focus chat again. This was not evidence of a separate
Recents navigation defect; stable tile targeting covers both restarts and reloads.

Remaining boundaries are explicitly tracked in omniagents
`docs/CHAT_WRITE_DURABILITY.md`: safe operator resolution of uncertain claims,
approval decision persistence before waiter resolution, and tool execution versus
event/canonical recording. These are not covered by a blanket exactly-once claim.
Azure verification remains excluded; historical databases were not repaired.

Visual proof command for this continuation:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/durable-queue-tile-server-report npx playwright test tests/e2e/specs/chat-durable-queue.spec.ts tests/e2e/specs/tile-pending-recovery.spec.ts --project=server-local --output=artifacts/durable-queue-tile-server-results
```

All four stories passed: the two crash cases and the existing two-tile question
and approval reconnect/reload cases. Both crash-recovery screenshots were inspected.
Report: `artifacts/durable-queue-tile-server-report/index.html`; screenshots,
traces and videos: `artifacts/durable-queue-tile-server-results/`. Earlier
`durable-queue-server` and `durable-queue-final-server` reports retain the failed
test assumptions and are not the final proof. Native Electron was not rerun in
this continuation. The owned temporary `omni-queue-inbox-pg` container was stopped
and automatically removed after PostgreSQL verification; no user data was removed.

## Human approval persistence — September 7, 2026

Function-tool and MCP approval decisions now commit durably before the server
resolves the waiter or grants an always-allow permission. Decision content and
terminal approval status commit together. Failed writes leave the prompt
retryable; an identical retry after a lost database acknowledgment succeeds,
while a conflicting choice fails. Only a live server-owned request can repair
a missing request projection; no historical data is reconstructed to authorize
execution. A stored approval is not evidence that the external tool ran.

The PostgreSQL concurrency suite also exposed a real SQLite history first-open
race (`duplicate column name: context_json`). The fix serializes cache creation
in-process and schema inspection/migration across database connections, with
dedicated simultaneous-initialization tests.

Both browser/server and native Electron two-tile approval proofs passed. They
exercise reconnect, reload, independent approval/rejection, and no cross-tile
resolution. Native screenshots were inspected. Exact proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/approval-durability-server-report npx playwright test tests/e2e/specs/tile-pending-recovery.spec.ts --grep 'two pending approvals' --project=server-local --output=artifacts/approval-durability-server-results

DISPLAY=127.0.0.1:99 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/approval-durability-native-report npx playwright test tests/e2e/specs/tile-pending-recovery.spec.ts --grep 'two pending approvals' --project=electron-local --output=artifacts/approval-durability-native-results
```

Reports are the corresponding `*-report/index.html`; screenshots, videos and
traces are in the corresponding `*-results/`. `npm run build` passed for native
Electron (`/tmp/omni-approval-electron-build.log`). The display ran in a disposable
Docker Xvfb/Openbox container; no host desktop configuration was changed.

Still pending: automatic guardian/sandbox-policy decision durability, external
tool execution/result reconciliation, and safe operator resolution of uncertain
queue claims. These are separate from the completed human-approval boundary.
Azure remains excluded, and no original historical database was modified.

Final broad verification: 1,137 backend session/runtime/conversation/agent/replay
tests passed; 117 PostgreSQL domain/history tests passed. The first PG run's
schema race was fixed, not skipped. Formatting and diff-whitespace checks passed.
The final focused approval/process-death/initialization run passed 34 tests,
including an additional migration-failure rollback and retry check.
Both owned Docker containers (`omni-approval-durability-pg` and
`omni-approval-proof-x11`) were stopped and automatically removed after testing;
their disposable state was removed, and no user database was touched. No files
were staged or committed.

## Automatic review, tool durability and tile identity — September 7, 2026

This continuation completed the automatic guardian/sandbox-policy approval
boundary and added conservative local function-tool dispatch/result guards.
Review persistence now precedes the decision; dispatch claims precede execution;
result persistence precedes completion delivery. Uncertain execution is labelled
as unknown, not safe to repeat. A late actual result is retained without reopening
the terminal item. Backend details and limits are in the sibling omniagents
`docs/CHAT_WRITE_DURABILITY.md`.

Additional bugs fixed:

- Tool rows and React keys used provider call ID alone, merging separate runs.
  They now include run identity. Late called/result events cannot reopen or
  overwrite a completed live row.
- Legacy projection could also emit duplicate item IDs when providers reused
  call IDs. Repeated occurrences now receive distinct history-position keys.
- MCP UI resources and tool catalogs were process-global; overlapping runs and
  out-of-order calls could select another invocation's UI. Runtime buckets are
  now per-run, with exact server/tool/call correlation and no ambiguous fallback.
  Rich UI is persisted with its result before stream consumption.

Permanent Playwright coverage now includes reuse of exactly the same provider
tool-call ID across two runs, before and after reload. Six browser/server proofs
and three native Electron proofs passed. They also recheck generated plans and
artifacts in their own tiles, pending approval isolation, question recovery and
the two queue process-death stories. Screenshots of native generated UI and the
browser repeated-tool transcript were inspected. Exact commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tool-durability-server-report npx playwright test tests/e2e/specs/chat-repeated-tool.spec.ts tests/e2e/specs/chat-durable-queue.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/tile-pending-recovery.spec.ts --project=server-local --output=artifacts/tool-durability-server-results

DISPLAY=127.0.0.1:99 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/tool-durability-native-report npx playwright test tests/e2e/specs/chat-repeated-tool.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/tile-pending-recovery.spec.ts --grep 'reuses an ID|generated plans|two pending approvals' --project=electron-local --output=artifacts/tool-durability-native-results
```

Reports: `artifacts/tool-durability-server-report/index.html` and
`artifacts/tool-durability-native-report/index.html`. Screenshots, traces and
videos are in the corresponding `*-results/` directories. Both `npm run
build:server` and `npm run build` passed. Targeted launcher verification passed
173 tests, TypeScript and ESLint.

Remaining limits: uncertain queue/tool claims cannot safely be released without
authoritative runtime fencing and outcome reconciliation. Hosted/provider-side
tools and non-function SDK tool families are outside the new local function-tool
hook contract. Canonical result persistence is not an atomic external-effect or
SDK context/history transaction. No blanket exactly-once guarantee is claimed.
Azure remains excluded; original historical databases were not repaired.

Final verification for this stage: 1,249 broad backend tests passed with one
old MCP fixture skipped. That fixture was then replaced: it had launched
`print('test')` rather than an MCP server and converted handshake failure into
a skip. The replacement exercises real stdio handshake, tool listing, invocation
and cleanup across fresh instances in the same and separate async tasks; both
cases passed. PostgreSQL domain/history coverage passed 120 tests, including
interrupted claims and late results. TypeScript, targeted ESLint/Prettier and
diff-whitespace checks passed. Test state used disposable databases and an
isolated display, not the user's profile.

The final combined adapter/tool-hook/MCP run passed 44 tests with no skips.
Owned containers `omni-tool-durability-pg` and `omni-tool-proof-x11` were stopped
and automatically removed after verification. Only disposable test state was
removed; proof artifacts remain. Nothing was staged or committed. The shadcn
skill guided the renderer scope: existing chat components were preserved, with
identity fixes rather than new UI components.

## Runtime ownership and context handoff — September 7, 2026

Staged plan and backend limits: sibling omniagents `docs/RUNTIME_RECOVERY.md`.

Implemented this continuation:

- Durable per-thread run reservations prevent two backend processes from both
  observing a locally idle session and starting competing runs. Queue dispatch
  and direct starts share the exclusion boundary. Ownership spans preparation,
  execution and cleanup; stale SDK model/tool callbacks fail closed.
- Loading a session no longer writes fake crash-recovery outputs while another
  runtime might own it. An exclusive new owner reloads durable history and SDK
  context before continuing; deliberately empty context stays empty.
- Exact run/call-correlated completed results can repair missing raw outputs.
  Repeated call IDs now remain distinct in model context, not only UI cards.
  Other SDK tool families do not receive invented function-output schemas.
- Pending, unstarted queue entries behind unresolved runtime ownership remain
  cancellable and show a clear notice. Uncertain dispatched entries remain
  non-cancellable and non-replayed. The shadcn skill guided reuse of the existing
  Alert component; no new design-system component or scroll behavior was added.

The previous pending-queue crash story expected immediate automatic draining
after killing a run. That assumption conflicts with the new ownership invariant:
a process disappearing from this runtime's view is not proof that external work
has stopped. The permanent story now verifies visible pause, no dispatch, reload
persistence, safe cancellation and tile isolation. Clean completed-run restart
remains covered separately.

Proof commands for this stage:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/runtime-ownership-final-server-report npx playwright test tests/e2e/specs/chat-repeated-tool.spec.ts tests/e2e/specs/chat-durable-queue.spec.ts tests/e2e/specs/chat-backend-crash.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=server-local --output=artifacts/runtime-ownership-final-server-results

DISPLAY=:0 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/runtime-ownership-native-report npx playwright test tests/e2e/specs/chat-repeated-tool.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts --project=electron-local --output=artifacts/runtime-ownership-native-results
```

Reports are the corresponding `*-report/index.html`; screenshots, videos and
traces are in the corresponding `*-results/` paths. The earlier
`runtime-ownership-server-report` retains the obsolete immediate-drain assertion
failure and is not the final proof.

Not complete: authoritative fencing of child processes/remote effects, safe
operator takeover/retry, provider-side execution outcome reconciliation, and
context recovery when both raw call and output are absent. The database owner
generation is not an external executor fence. There is intentionally no timeout
or force-release button that can turn an unknown outcome into permission to
repeat it. Azure remains excluded; original historical databases are untouched.

Verification completed: 1,261 broad backend tests passed with no skips; the final
focused ownership/context/lifecycle suite passed 97 tests, including the last
non-function output-schema regression. PostgreSQL passed 124 tests. Launcher
passed 93 targeted tests, TypeScript and targeted ESLint. Python formatting and
both repositories' diff-whitespace checks passed. Server/browser and native
production builds passed.

All five final browser/server proofs and both native Electron proofs passed.
The paused-queue browser screenshot and native recovered plans/artifacts
screenshot were inspected. The owned `omni-runtime-ownership-pg` container was
stopped and automatically removed; only disposable test state was removed.
Proof artifacts remain. No files were staged or committed.

## Core protocol audit (2026-09-07)

The first-principles follow-up is tracked in
[chat-protocol-invariants.md](chat-protocol-invariants.md), including convergence
regressions, snapshot/database consistency, operation semantics, ownership and
the exact server/native visual proof commands. A pre-existing v1 compatibility
failure requires a maintainer decision; do not interpret earlier stage completion
as closure of that release blocker.

## Independent Linux command supervision — September 7, 2026

The backend now starts each Linux host command under a separate supervisor. A
backend-owned lifetime pipe triggers command-group retirement after backend
SIGKILL. A Linux subreaper waits for ordinary orphan descendants, including a
child whose original parent already exited. Private per-execution journals retain
run-owner identity and completion/cleanup evidence, without command text,
environment secrets, stdin or output. Background jobs continue reporting the
command PID, not the supervisor PID. Startup publication is cancellation-safe.

Unconfirmed cleanup now prevents releasing the current run reservation, including
same-process release retries. This is deliberately not a force-takeover or replay
feature. Detached survivors, supervisor death, non-Linux platforms, remote effects
and missing model context still need stronger recovery boundaries. The detailed
contract and remaining work are in `omniagents/docs/RUNTIME_RECOVERY.md` in the
sibling repository. Foreground command completion includes ordinary descendants;
explicit managed spawn remains the background-job path.

Extended `chat-executor-retirement.spec.ts` with a genuine agent-backend SIGKILL
story. It finds the supervisor within this fixture's runtime descendants, kills
only its backend parent, and verifies command PIDs stop and the journal confirms
retirement **before** fixture restart. With two conversations present, restart
keeps the interrupted chat's queued message paused, does not replay it, preserves
the other chat's content, and removes its dead approval waiter. Ordinary Stop
still permits the owner chat to run again while the other tile awaits approval.
The proof scrolls the interrupted tile into view after restart, which may add a
fresh draft tile; otherwise that draft can push the relevant notice offscreen.

Verification: the broad backend suite passed 1,581 tests. The final combined
focused run passed 294 checks, including 126 PostgreSQL tests; the subsequent
workspace/job/lifecycle run passed 162 tests including command-PID compatibility.
The initial detached-child test used `os.pidfd_open`, unavailable in this Python
build; its test-only cleanup now verifies the test child's unique temporary-path
argument before signalling it. The corrected regression passed and confirms a
detached survivor keeps ownership unresolved. The earlier test-owned survivor
was explicitly stopped. This limitation did not affect product supervisor code.

All six browser/server and three native Electron proofs passed. Following startup
hardening, both executor browser stories and the native Stop story passed again.
TypeScript, targeted ESLint/Prettier, Python formatting and diff checks passed.
Frontend product code was unchanged; proofs used existing launcher bundles with
the current editable backend. Azure remained excluded.

Proof commands (from the launcher repository):

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/command-supervisor-server-report npx playwright test tests/e2e/specs/chat-executor-retirement.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts tests/e2e/specs/chat-durable-queue.spec.ts --project=server-local --output=artifacts/command-supervisor-server-results

DISPLAY=:0 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/command-supervisor-native-report npx playwright test tests/e2e/specs/chat-executor-retirement.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --grep-invert 'Backend death' --output=artifacts/command-supervisor-native-results

OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/command-supervisor-crash-proof-report npx playwright test tests/e2e/specs/chat-executor-retirement.spec.ts --project=server-local --grep 'Backend death' --output=artifacts/command-supervisor-crash-proof-results
```

Each report is `artifacts/<report-name>/index.html`; screenshots, traces and videos
are retained in the corresponding results directories. Additional targeted reruns
are under `artifacts/command-supervisor-final-{server,native}-{report,results}/`.

The final crash proof passed and its screenshot was inspected with both affected
conversations readable. The owned `omni-command-supervisor-pg` container was
stopped and automatically removed; only its disposable test database was removed.
Proof artifacts and execution evidence were retained. Nothing was staged or committed.

## Executor retirement and safe local release recovery — September 7, 2026

Backend fixes: host command cancellation previously left processes running;
timeouts/termination could kill only the shell, leaving its children alive.
Host exec/spawn now use owned POSIX process groups, cancellation-safe handle
publication, bounded TERM/KILL cleanup, and output-drain-aware wait deadlines.
Concrete Workspace writes/commands and ProcessHandle stdin check run ownership,
including cached objects and overrides. Closing runs reject new operations but
retain their reservation until already-admitted I/O settles. Repeated cancellation
does not abandon an in-progress host filesystem write.

The same live backend can retry its own failed database release after the worker
and admitted operations finish. This is not permission to release a foreign or
crashed runtime. Unknown external effects remain paused; authoritative remote
execution fencing and full context recovery are still open in the sibling
`omniagents/docs/RUNTIME_RECOVERY.md`.

Added permanent `chat-executor-retirement.spec.ts`: run a real command with a
SIGTERM-resistant child, keep another tile awaiting approval, stop the first tile,
verify both owned process IDs are no longer executing, and start a fresh turn in
the first tile without affecting the second. The initial proof incorrectly
assumed a second tile existed; the spec now creates it explicitly. No product
behavior was weakened to satisfy that assertion.

Final proof commands:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/executor-retirement-final-server-report npx playwright test tests/e2e/specs/chat-executor-retirement.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts tests/e2e/specs/chat-durable-queue.spec.ts --project=server-local --output=artifacts/executor-retirement-final-server-results

DISPLAY=:0 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/executor-retirement-final-native-report npx playwright test tests/e2e/specs/chat-executor-retirement.spec.ts tests/e2e/specs/chat-stop-retry.spec.ts --project=electron-local --output=artifacts/executor-retirement-final-native-results
```

Reports are the corresponding `*-report/index.html`; screenshots, traces and
videos are in `*-results/`. The earlier reports without `final` retain the
incorrect tile-setup assertion and are not the final proof. Frontend product code
was unchanged in this continuation; proofs used the existing built bundles and
the editable backend containing these changes. Azure stayed excluded.

Final results: all five browser/server and three native Electron proofs passed.
The native command-tree retirement screenshot was inspected. The expanded backend
suite passed 1,566 tests; the final workspace/job/lifecycle run passed 150 tests,
including the last stdin and sandbox guard regressions. PostgreSQL passed 125
tests. TypeScript, targeted ESLint/Prettier, Python formatting and both repositories'
diff-whitespace checks passed. The owned `omni-executor-retirement-pg` container
was stopped and automatically removed, removing only disposable test state.
Proof artifacts remain. No files were staged or committed.
