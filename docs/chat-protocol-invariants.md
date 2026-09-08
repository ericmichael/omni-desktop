# Core chat protocol invariant audit

Scope: the GUI chat RPC plane, its session controllers, durable conversation
projection and replay. Real-time voice, terminal protocols, Azure deployment and
general external-effect crash recovery are separate contracts. Existing unrelated
changes are preserved; no commits or protocol baseline rewrites are authorized.

## Completion criteria

For each boundary below, inspect the implementation, add/run permanent checks,
fix reproduced violations, and record evidence or an explicit support limitation.
Do not interpret passing scenario tests as a proof of every possible interleaving.

| Boundary                  | Required invariant                                           | Status                                                            |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Snapshot/live/replay      | Same durable content; exact watermark; no stale replacement  | Regressions fixed and checked; topology limit below               |
| Operation lifecycle       | Distinguish observation, attach, creation and dispatch       | Inspected; attach semantics documented below                      |
| Command identity          | Lost replies never create a new logical submission           | Existing receipt tests and browser recovery proofs pass           |
| Client requests           | Durable content survives; actions require live ownership     | Status/MCP regressions fixed; existing approval behavior verified |
| Session/run/view identity | Tiles do not determine routing or execution                  | Late-output/run collision fixed; tiled proofs pass                |
| Compatibility             | Unsupported/invalid responses fail explicitly, not partially | Decoder added; pre-existing v1 release blocker remains            |

## Test method

Compare normalized conversation state after live delivery, reconnect replay and
fresh snapshot loading. Exercise legal response/event interleavings, duplicate
delivery, cursor compaction, repeated provider IDs across runs, independent
sessions and multiple consumers of one session. Use existing state-machine and
replay code, not an independently invented UI reducer. Supplement client traces
with actual backend recorder/event-log/store tests and permanent tiled UI proofs.

## Source anchors

- Backend `rpc/protocol.md`, `rpc/protocol_catalog.py`, `core/session/event_log.py`.
- Backend `core/agents/service.py`: `queue_status`, `resume_session`, submission
  and client-response handling.
- Backend `core/conversation/{recorder,store,runtime_snapshot}.py`.
- Launcher `rpc/{client,replay,canonical-chat-history}.ts` and `session/`.

## Findings and evidence

### Fixed in this audit (2026-09-07)

- Status requests had a separate handler from other client requests. They now
  use the same acknowledgement/retry path. Snapshots restore acknowledged display
  state without answering requests or executing client tools again.
- Late assistant output used the currently active run instead of its originating
  run. The event's run identity now survives transcript projection.
- MCP UI surfaces reused call IDs across runs and were absent from fresh canonical
  history. One shared adapter derives them from durable tool metadata, keyed by
  session, run and call identity.
- Snapshot items and queue could reflect different database versions, including
  during cross-process writes. SQLite now reads both in one transaction;
  PostgreSQL uses a repeatable-read, read-only transaction. Full item hydration
  replaces independently paginated reads.
- Snapshot responses are validated before hydration: session identity, item
  identity/order, watermark, pending-request ownership and display-state allowlist.
  Unsupported snapshots fail explicitly instead of partially populating the UI.

Permanent differential checks: `session/protocol-convergence.test.ts` uses real
controllers and replay coordination at five reconnect cuts, duplicate replay,
fresh canonical hydration, repeated MCP call IDs and acknowledged display state.
`rpc/session-snapshot.test.ts` covers invalid boundaries, including attempts to
smuggle executable client actions into display state. Backend
`test_protocol_snapshot.py` exercises a concurrent SQLite writer;
`test_store.py` checks full snapshots beyond the former page boundary on both stores.

The suspected stale approval after authoritative reload did **not** reproduce:
existing hydration already clears it. Retained the regression test without
changing that behavior.

### Architectural conclusions and limits

- `queue_status`, `list_queue` and `resume_session` are attach/reconciliation
  operations, not pure observational reads: they can load a session, attach a
  channel or drain previously accepted work. Do not call them under an assumption
  of zero lifecycle effects. This audit does not redefine those RPCs.
- Submission identity belongs to a durable command receipt, not a window or RPC
  attempt. Existing receipt checks cover retries, payload conflicts, durable
  restart and uncertain ownership; browser proofs cover lost/late replies.
- Durable plans/artifacts are distinct from approvals/questions backed by live
  waiters. Reload must preserve the former without resurrecting the latter.
- Database snapshot consistency is not cross-process event fanout. Runtime tasks,
  pending waiters and event streams remain process-local. The snapshot cursor is
  coherent with the serving runtime, not a distributed active-active stream.
- Real MCP surface behavior has differential/unit coverage; the real UI proofs
  exercise generated plans/artifacts and repeated tool calls, not a live MCP app.
- Azure and real-time voice remain outside this audit. Passing these scenarios
  does not establish correctness for all possible event interleavings.

### Release blocker: v1 compatibility

Update (2026-09-07): the user approved a new major. The migration design is in
`../omniagents/docs/development/gui-protocol-v2-migration.md` (path relative to
the launcher repository root). This resolves the direction decision, not the
implementation/release gate. It covers all four clients, bidirectional handshake
validation, preserved v1 release evidence, and reviewed-source Desktop sync.

The immutable `protocol/openrpc/baseline/1.0.0` compatibility check fails:

- `start_run.params.content` adds a `oneOf` restriction to unconstrained input.
- `start_run.params.environment_selection` is newly required.

Both requirements are already present in the server's committed HEAD. This audit
did not introduce them. The generated-artifact consistency check passes with the
backend virtualenv on PATH. Generation consistency is **not** compatibility.

The committed compatibility test explicitly accepts the environment-selection
break as intentional for an unreleased protocol, but does not accept the content
restriction. That test now fails. Its unreleased-contract assumption also
conflicts with the governance document's immutable-release/additive-v1 rules;
this is a release-policy inconsistency, not evidence that environment selection
should be made optional. Correct-PATH schema/compatibility tests: 44 passed,
1 failed on that additional content restriction.

Do not rewrite the baseline, silently relax environment safety or invent a major
release to make the check green. Maintainer direction is required: restore a safe
v1-compatible contract, or authorize an explicitly versioned/negotiated breaking
contract. Until that decision is resolved, this audit is not fully closed.

## Verification

- Launcher RPC/session/machine tests: **394 passed** (29 files).
- Targeted TypeScript and ESLint checks pass; server and Electron builds pass.
- Disposable PostgreSQL and concurrent SQLite checks: **128 passed**.
- Broad backend run: **2,147 passed, 2 failed**. One failure was the local
  `datamodel-codegen` shim/PATH setup; rerunning the schema/compatibility group
  with the virtualenv on PATH produced **44 passed, 1 failed**, leaving only the
  content-compatibility failure described above. The additional display-state
  test group passed **6 tests**. The broad run preceded that last test addition.
- Visual proof: **4 server-local and 2 electron-local tests passed**.

Exact proof commands, run from launcher:

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/protocol-audit-server-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-repeated-tool.spec.ts tests/e2e/specs/shared-submission-recovery.spec.ts --project=server-local --output=artifacts/protocol-audit-server-results
DISPLAY=:0 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/protocol-audit-native-report npx playwright test tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-repeated-tool.spec.ts --project=electron-local --output=artifacts/protocol-audit-native-results
```

Reports: `artifacts/protocol-audit-server-report/index.html` and
`artifacts/protocol-audit-native-report/index.html`. Traces/videos are in the
matching `protocol-audit-server-results` and `protocol-audit-native-results`
directories. Artifacts remain untracked; no files have been staged or committed.
The owned disposable PostgreSQL container was stopped and automatically removed;
only its temporary test database was deleted (not retained for recovery). User
databases were not touched. Targeted formatting and both repositories' diff
whitespace checks pass. A native video frame was inspected with updated A/B
plans and artifacts visible in their respective tiles.
