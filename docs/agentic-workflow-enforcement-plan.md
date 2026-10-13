# Agentic Workflow Enforcement at the Plan Layer

## Summary

Make the agent's internal task list (`task_create` / `task_update` and the durable
plan item behind them) the workflow layer: the agent authors its own process as a
step DAG, guided by skills, and the harness holds it to that process the way the
kanban board held it to columns. Enforcement is two-tier: **mechanical** (dependency
edges block starting a step) and **semantic** (a guardian-style one-shot reviewer
judges whether a step's exit criteria are actually met before a `completed` status
lands). Project pipelines are _not_ changed in this plan; collapsing them to
backlog/doing/done is a deferred follow-on gated on the plan layer proving out.

Why this layer and not workflow templates at the ticket/pipeline level: the DAG
machinery already exists (symmetric `blocks`/`blockedBy` edges enforced at write
time, `open_blockers` computed on read, durable per-`(thread, scope)` items with
generations — `omniagents/core/conversation/plans.py`), the agent already authors
graphs agentically, loops/branches are handled by replanning instead of
pre-authored contingencies, and plan construction is tool calls over structured
data — so skill adherence is measurable by evals. What's missing is only
enforcement, and the guardian (`omniagents/core/agents/guardian.py` +
`approval_policy.py`) is a debugged prototype of exactly that mechanism:
one-shot tool-less judge, strict-parse-or-degrade, deny-with-rationale routed
back to the model, per-run circuit breaker, tiered routing, policy-as-shipped-file.

Repos touched: **omniagents** (core mechanism), **omni-code** (skill/instruction
contract, context injection), **launcher** (cross-session plan seeding).

## Key changes

### A. Plan schema — `omniagents/core/conversation/plans.py`

- `PlanStep` gains three fields:
  - `exit_criteria: str = ""` — the checkable definition-of-done for this step.
    Empty means "no semantic review for this step" (the natural opt-in).
  - `review: Optional[dict] = None` — outcome of the last completion review:
    `{"outcome": "verified" | "unverified" | "waived", "reviewer": "guardian" | "human" | "none", "rationale": str}`.
    `None` until the step first reaches `completed`.
  - `original_exit_criteria: str = ""` — the criteria-edit ratchet's record:
    set once, to the pre-edit value, the first time `exit_criteria` changes
    while the step is `in_progress` (including an edit arriving in the same
    `task_update` call that sets `completed`). Later edits keep the FIRST
    original. Empty means the criteria were never edited mid-step. Persisted
    snake_case, defensive parse like the others.
- Persisted snake_case in `to_dict`/`from_dict` (defensive parse like every other
  field: non-string criteria → `""`, malformed review → `None`). Wire shape in
  tool results is camelCase (`exitCriteria`), matching the existing
  `activeForm`/`active_form` precedent — both additive, so `tasks_snapshot`
  consumers (launcher panel, Ink TUI) are unaffected.
- `to_summaries()` adds `exitCriteria`, a compact `verified` boolean-or-null so
  the launcher panel can badge unverified completions, and `criteriaEdited`
  (bool, derived from `original_exit_criteria` being non-empty).

### B. Mechanical guard — `omniagents/builtin/tools/task_list_tools.py`

- `task_create` accepts optional `exitCriteria: str`.
- `task_update` accepts optional `exitCriteria: str` (edit) and
  `overrideBlockers: bool = False`.
- **Start guard:** `task_update(status="in_progress")` on a step whose
  `open_blockers()` is non-empty returns the existing `_error` shape with
  `{"error": "blocked", "openBlockers": [...]}` and a preview naming the blocking
  steps — unless `overrideBlockers=true`, which proceeds and records nothing
  special (the transcript already shows the override). No guard on `pending`,
  `blocked`, or edits.
- **Completion guard:** `task_update(status="completed")` on a step with
  non-empty `exit_criteria` routes through completion review (section C) before
  the write. Steps without criteria complete exactly as today, with
  `review = {"outcome": "waived", "reviewer": "none", "rationale": ""}`.
- **Edge integrity:** `task_update` gains `removeBlockedBy` (symmetric edge
  removal, silent no-op for absent edges — the ordinary fix for a mis-drawn
  edge, preferred over `overrideBlockers` or deletion), and a dependency
  edge that would close a cycle is refused with error `dependency_cycle`
  naming the existing chain — in an all-of precedence model a cycle can
  never mean iteration, only deadlock. Validation runs before the
  completion review (a refusal must not leave review side effects) and
  simulates the call's removals before its additions, incrementally, so
  two additions in one call cannot smuggle a cycle in. `link()` itself also
  refuses cycles, so persisted plan content can never hold one regardless
  of caller.
- **Criteria-edit ratchet:** an `exitCriteria` edit on a step whose status is
  `in_progress` — or arriving in the same call that sets `status="completed"`
  — stamps `original_exit_criteria` with the prior value (first such edit
  only; later edits preserve the first original). Edits while `pending` or
  `blocked` are free: refining an unstarted step is planning, not weakening.
  The edit itself is never blocked and fires no review call — the record is
  weighed at completion review (section C) and surfaced in the UI (section
  H). Extension stays frictionless; only the contract's history is kept.
- Both guards run before `handle.write()`; a denial writes nothing.
- Docstring updates so the model sees the contract: `exitCriteria` described on
  both tools ("state a criterion an outside reviewer could check from the
  transcript: a command that must have run and passed, a file that must exist, a
  PR that must be open"), and `task_update`'s status docs state that completion
  of a step with criteria is reviewed and may be rejected with a rationale.

### C. Completion review — new `omniagents/core/agents/plan_review.py`

Sibling of `guardian.py`, same skeleton, different policy and posture:

- `review_completion(service, session, request) -> Optional[PlanReviewAssessment]`.
  `PlanReviewRequest` carries the step's `subject`, `description`,
  `exit_criteria`, `original_exit_criteria` (empty when never mid-edited),
  and plan/scope identity. When the original is non-empty the judge prompt
  includes BOTH criteria and the policy directs: a completion that satisfies
  the edited criteria but plainly not the original is criteria-fitting —
  reject unless the transcript shows a legitimate reason for the change
  (a discovered constraint, corrected scope). Service and session come from the
  tool layer via the existing `current_service()` / `session_from_ctx` accessors
  (`core/session/helpers.py`) — no new plumbing.
- Prompt = compact transcript (reuse `_compact_transcript` and the clip
  constants from `guardian.py` — extract them to a shared helper rather than
  duplicating) + the step under review. Judge runs via `run_agent_once`
  (`core/runtime/ephemeral.py`), serialized per session with the same lock
  pattern.
- **Reviewer capabilities:** the reviewer is a bounded agentic run (small
  `max_turns`, 120s timeout) with READ-ONLY workspace tools — read/list/
  glob/grep — bound to the session's environment (the workspace may live in
  a sandbox; the reviewer's tools must execute where the doer's do). No
  tagging or routing layer: the reviewer itself decides per review whether
  the transcript suffices or the workspace needs checking, and spends zero
  tool calls when the evidence is already on the record. Execution tools
  are excluded — a criterion that needs a command run is satisfied by the
  DOER's own run appearing in the transcript, never by the reviewer
  executing. Everything else — verdict schema, strict parse, fail-open,
  breaker, broadcasts — is unchanged.
- Policy file `plan_review_policy.md` shipped next to the module. Two axes:
  - `criteria_met`: `satisfied` | `unsatisfied` | `indeterminate` — does the
    transcript support the criteria being met?
  - `evidence`: `shown` | `asserted` | `absent` — is there tool output
    demonstrating it, or only the agent's claim?
  - Outcome rule: `reject` only when `criteria_met=unsatisfied` **and** the
    transcript affirmatively shows the work missing or failing (e.g. criteria
    say tests pass, transcript shows a failing or absent test run). Everything
    else — including `indeterminate` — is `accept`. The policy states
    explicitly: the reviewer is a process check, not a security gate; when in
    doubt, accept.
- Strict JSON parse copied from `parse_assessment` (fenced-block tolerance,
  closed enums, non-empty rationale); any deviation → `None`.
- **Fail-open-to-allow:** `None` (timeout, model error, malformed output) means
  the completion is accepted with
  `review = {"outcome": "unverified", "reviewer": "none", "rationale": "review unavailable"}`.
  This is the deliberate posture difference from the security guardian (which
  fails to the human): the stake here is process discipline, and the
  `task_list_tools` rule that plan bookkeeping must never abort a turn governs.
- **Accept path:** step completes with `outcome: "verified"` (evidence shown) or
  `"unverified"` (accepted on `indeterminate`/asserted evidence), reviewer
  `"guardian"`, and the rationale stored.
- **Reject path:** tool returns the `_error` shape with
  `{"error": "exit_criteria_not_met", "rationale": ...}`; the step stays in its
  prior status. Same codex-style deny-back-to-model the guardian uses — the
  rationale is the steering signal.
- **Circuit breaker:** own per-`(session, run)` counter (same
  `_breaker_state`-style session attribute, distinct key from the guardian's).
  After **2** consecutive rejections on the _same step_, the third
  `completed` attempt is accepted with
  `review = {"outcome": "unverified", "reviewer": "guardian", "rationale": "accepted after repeated disagreement: <last rationale>"}`
  and, when the session has an approval-capable client, an ordinary approval
  broadcast is emitted informationally (reusing the assessment-display path the
  launcher already renders for guardian decisions) so the human sees the
  contested completion in the transcript. Headless/autopilot runs get the same
  accept-unverified outcome with no prompt — the breaker never parks a run.

### D. Routing and config — `omniagents/core/config/layered.py`

Mirror the `approvals.*` block with hot-reload keys:

- `workflow.completion_reviewer`: `"guardian"` (default) | `"user"` | `"off"`.
  `off` waives all reviews; `user` routes every criteria-bearing completion to
  the existing human approval prompt instead of the judge (for users who want to
  eyeball completions); `guardian` as described. Per-session override attribute
  `session.workflow_reviewer`, same precedence rule as `effective_reviewer`.
- `workflow.guardian_model`: optional model ref, same semantics as
  `approvals.guardian_model` (empty → session's model). Point it at a cheap
  model in omni-code's shipped config.
- A pure `resolve_completion_route(reviewer, step) -> off | guardian | human`
  function (no criteria → `off`), unit-testable like `resolve_route`.

Cost bounding: reviews only fire on criteria-bearing completions, serialized per
session, one-shot on a configurable cheap model. No review on create, edit,
delete, or start.

### E. Plan-in-context — omni-code

The plan must stay in the agent's face without requiring a `task_list` call.
Add the current plan to the omni agent's dynamic instructions via the existing
context factory (`omni_code/agents/omni/context.py`): when the session has a
live plan with open steps, render a short block — step lines in the
`tasks_snapshot` format plus a "next unblocked" line — into the instruction
template. Instructions rebuild per run, which covers session start, resume, and
post-compaction; intra-run state is already covered by every plan tool result
echoing the snapshot. No omniagents core change needed.

### F. Cross-session seeding — launcher

Plans are thread-scoped by design (`plans.py::list_plans` — a relaunched ticket
session starts a fresh thread and an empty plan). Carry the workflow forward at
the prompt level, not the storage level:

- The ticket-machine already receives `tasks_snapshot` updates from the running
  session (the docked task panel). Persist the latest snapshot on the ticket
  record in projects-db as an opaque JSON column (`last_plan_snapshot`), updated
  on the same path that feeds the panel.
- On (re)launch, `SupervisorContext` (`src/main/supervisor-prompt.ts`) gains
  `priorPlan?: PlanSnapshotEntry[]`. When present and containing incomplete
  steps, the prompt renders a "## Prior plan" section: completed steps listed as
  done context, incomplete steps with their `exitCriteria`, and the instruction
  to recreate the incomplete steps with `task_create` (including criteria and
  blocker edges) before starting work. The agent rebuilding its own plan keeps
  authorship agentic and tolerates staleness; no RPC- or recorder-level seeding.
- Snapshot is cleared when the ticket reaches a done column, alongside existing
  ticket settlement.

### G. Skills contract — omni-code

The division of labor: **skills carry process knowledge, the plan carries the
live instance, the guards carry enforcement.** Update the omni agent's
instructions (`agents/omni/instructions.md`, tasks section) to state:

- For multi-step work, build the plan as a dependency graph: edges via
  `addBlockedBy`, and `exitCriteria` on every step whose completion is
  externally checkable. State criteria as evidence, not intent ("`npm run
test:no-watch` passes", not "code is tested").
- Keep the existing ≥3-non-trivial-steps threshold; small tasks get no plan and
  therefore no review friction.
- Skills that define task-type workflows (bugfix, feature, release, …) specify
  the step graph _and_ per-step exit criteria; the criteria are what the
  reviewer later checks, closing the skill → plan → enforcement loop.

No new skill infrastructure — this is instruction text plus a convention for
skill authors.

### H. UI/UX — launcher

The enforcement mechanics must be legible or they read as the agent
mysteriously retrying. All changes are additive to existing surfaces; no new
panel, app, or settings surface.

- **Tasks pill/popover (`PillStrip.tsx`):** each row gains its `exitCriteria`
  as a secondary line (present only when set), and completed steps split by
  verification: solid check for `verified`, hollow/amber check for
  `unverified` with the review rationale as the row tooltip. The popover
  header counts line adds "N unverified" when nonzero. Unverified is a trust
  signal, not an error — amber/muted styling, never destructive. The existing
  "blocked by #n" rendering is unchanged (the start guard just makes it
  truthful). Data comes from the `exitCriteria`/`verified` fields added to
  `to_summaries()` (section A); `TaskSummary` in
  `canonical-plan-tasks.ts` extends accordingly.
- **Workflow review steps (`ActivityChain.tsx`):** transcript machinery —
  reasoning, tool calls, guardian decisions, workflow reviews — renders as
  one ChainOfThought timeline per run (auto-open while streaming,
  auto-collapse when done unless something failed; header carries counts
  with failures/rejections in destructive tint). Within it, every REVIEWED
  completion outcome renders as a step:
  rejections ("step #3 'run tests' — rejected: no test run in transcript",
  destructive shield, expandable rationale), breaker escalations,
  unverified accepts (amber), and clean verifications ("completion
  verified", quiet primary-tinted shield, matching the guardian's approve
  tone). Only waived completions (no criteria / reviewer off) stay silent —
  nothing was reviewed. The broadcast (`plan_completion_reviewed`, outcome
  `accept_verified` added) fires for the same set. Noise reduction of
  verified chips is deliberately deferred — the record comes first, a
  collapse/filter treatment later. Plan tool results themselves remain
  `hidden: true`; the chip is what makes a denial visible, since otherwise
  the user sees only an unexplained retry. Additive to the transcript —
  nothing is hidden or deduped.
- **Kanban card (`KanbanCard.tsx`):** cards for tickets with a
  `last_plan_snapshot` (section F — same column, no new data path) show a
  step fraction (`3/7`), the active step's `activeForm` as a one-line live
  status (same shimmer treatment as the pill), a blocked indicator, and an
  unverified count when nonzero. This is the piece that makes the deferred
  pipeline simplification (I) viable UX: process detail moves from board
  geography into the card as columns get coarser.
- **Resume:** no new UI. Seeding (F) makes the pill visibly repopulate on the
  first turn of a relaunched ticket — done steps acknowledged, incomplete
  steps recreated — which is the user-visible proof the workflow is durable.
- **Escalation:** breaker escalations produce a transcript chip only — never
  a blocking card, modal, or badge. Human-owned gate steps (`owner` set to a
  human principal, status `blocked`) surface as inbox items with the standard
  sidebar badge ("agent is waiting on you: <step subject>"), cleared when the
  step leaves `blocked`. Reuses the inbox/badge attention system; no new
  notification surface.
- **Settings:** the workflow reviewer (`off` / `guardian` / `user`) is a
  sibling select next to the approvals reviewer in `ModelSessionControls` —
  same popover, session-scoped override of the config default. When set to
  `user`, criteria-bearing completions render as the existing interactive
  `ApprovalCard` flow.
- **Criteria-edit annotation:** a task row whose snapshot entry carries
  `criteriaEdited: true` shows a muted "criteria edited mid-step" note beside
  the criteria line (popover and, when completed unverified, in the tooltip).
  Informational only — same amber/muted register as unverified.
- **Agents sidecar worker-plan drill-down:** a worker row in the Agents
  sidecar expands to show that worker's own plan — same row rendering as the
  tasks popover (status dot, `#id`, subject, criteria line, verified state) —
  read via the worker's session id over the existing plan/session read RPC
  (workers carry `parent_session_id`; no new omniagents protocol). Live while
  the worker runs; last-known state when finished if cheaply retrievable,
  otherwise absent. Read-only: the parent plan remains the ticket's workflow
  and worker plans stay private (fractal model) — this is observability, not
  shared planning.
- **Out of scope:** any change to guardian security chips, and any new
  rendering of plan tool results.

### I. Deferred: pipeline simplification

Not in this plan. Once the plan layer demonstrably carries process (criteria
adoption in real tickets, review outcomes mostly `verified`), a follow-on plan
collapses default pipelines toward backlog/doing/done and reduces
`nextTransitionText` to coarse commits. Nothing in this plan blocks or assumes
that change; `move_ticket` and column DoDs keep working as today.

## Interface changes

Tool surface (additive, wire shapes frozen elsewhere by `tasks_snapshot` consumers):

```
task_create(subject, description, activeForm?, exitCriteria?)
task_update(task_id, status?, subject?, description?, activeForm?, owner?,
            addBlocks?, addBlockedBy?, removeBlockedBy?, exitCriteria?,
            overrideBlockers?)
```

New error payloads (existing `_error` envelope):

```json
{"task_id": "3", "error": "blocked", "openBlockers": ["1", "2"]}
{"task_id": "3", "error": "exit_criteria_not_met", "rationale": "..."}
{"task_id": "3", "error": "dependency_cycle",
 "edge": {"blocker": "2", "blocked": "3"}, "path": ["2", "1", "3"]}
```

Reviewer output (strict, `plan_review.py`):

```json
{
  "criteria_met": "satisfied | unsatisfied | indeterminate",
  "evidence": "shown | asserted | absent",
  "outcome": "accept | reject",
  "rationale": "one or two sentences naming the decisive factor"
}
```

Config keys: `workflow.completion_reviewer`, `workflow.guardian_model` (both
`reload=hot`). Launcher DB: `last_plan_snapshot TEXT NULL` on tickets, next
projects-db schema version, no backfill (null = no prior plan).

## Test plan

- **omniagents (pytest):**
  - Start guard: in_progress with open blockers → `blocked` error listing them;
    `overrideBlockers=true` proceeds; completed blockers don't block.
  - Completion routing: no criteria → waived, no judge call; criteria + `off` →
    waived; criteria + guardian → judge invoked with the step and transcript.
  - Judge outcomes: accept-verified, accept-unverified (indeterminate), reject
    (step status unchanged, error carries rationale), malformed/timeout →
    accept-unverified (mock `run_agent_once`).
  - Breaker: two rejections on one step → third attempt accepts unverified;
    counter resets on a different step and on accept.
  - Schema: `PlanStep` round-trips `exit_criteria`/`review`/
    `original_exit_criteria`; malformed values degrade per the
    defensive-parse convention; `to_summaries` carries `exitCriteria`/
    `verified`/`criteriaEdited`.
  - Edge integrity: direct and transitive cycles refused with the chain
    named and nothing written; two additions in one call cannot form a
    cycle; diamond fan-out/fan-in stays legal; `removeBlockedBy` removes
    symmetrically, unblocks the start guard, tolerates absent edges, and a
    same-call removal legalizes an addition it unblocks.
  - Ratchet: first in-progress edit stamps the prior value; later edits keep
    the first original; edits while pending/blocked don't stamp; an edit in
    the same call as `completed` stamps AND the review request carries the
    original; the judge prompt includes both criteria when stamped.
  - `resolve_completion_route` truth table.
- **launcher (vitest):**
  - Snapshot persistence: tasks_snapshot update path writes
    `last_plan_snapshot`; settlement clears it.
  - `supervisor-prompt`: `priorPlan` with incomplete steps renders the section
    with criteria and the recreate instruction; absent/fully-complete prior plan
    renders nothing.
  - Tasks popover: verified vs unverified completed rows render distinct
    states; `exitCriteria` line renders only when set; header adds the
    unverified count.
  - Review chip: renders for reject/escalation/unverified-accept items,
    not for clean verifications; rationale expands.
  - Kanban card: step fraction, active-step line, and blocked/unverified
    indicators render from `last_plan_snapshot`; cards without a snapshot are
    unchanged.
  - Criteria-edit annotation renders only when `criteriaEdited` is true.
  - Sidecar drill-down: a worker row expands to the worker's plan rendered
    from a plan fixture; workers without a readable plan render no plan
    section.
- **eval (follow-on, omniagents eval framework):** a scenario asserting a
  bugfix-skill run produces a plan containing a repro step blocking the fix
  step with non-empty criteria — the measurability payoff, not a merge gate.

## Rollout order

1. Schema fields + mechanical guard (self-contained, immediately useful).
2. `plan_review.py` + policy + config keys + tool interception.
3. omni-code instruction/context changes (E, G).
4. Launcher seeding (F).
5. Launcher UI (H): popover verification states and review chips ride
   step 2 (they render the new snapshot/review data); kanban card and
   human-gate inbox items ride step 4 (they need `last_plan_snapshot`).
6. Criteria-edit ratchet (omniagents: schema stamp + edit-aware judge) and
   Agents sidecar worker-plan drill-down (launcher). Independent of each
   other; the ratchet's UI annotation rides the new `criteriaEdited`
   snapshot field.

Each step lands independently; nothing breaks if a later step waits.

## Assumptions

- Breaker escalation is informational, never blocking: contested completions
  accept as `unverified` after 2 rejections rather than parking autopilot runs
  on a human prompt. Chosen over guardian-style fail-to-human because the stake
  is discipline, not damage.
- Default `workflow.completion_reviewer` is `guardian`, safe because review
  only triggers on steps that opt in via `exitCriteria`.
- Seeding is prompt-level (agent recreates steps) rather than storage-level
  (copying plan items across threads) — keeps plan authorship agentic, avoids a
  second write path into the conversation store, tolerates workspace drift
  between runs.
- `last_plan_snapshot` lives on the ticket row rather than re-keying plans to
  tickets — avoids moving plan storage into projects-db and rebuilding the
  two-layer split this design collapses.
- Transcript compaction helpers are extracted from `guardian.py` and shared;
  the security guardian's behavior is unchanged.
- Criteria edits are never blocked, only recorded and weighed at completion
  review — extension stays frictionless; the ratchet targets weakening (the
  criteria-fitting failure mode), not dynamism.
- Worker plans stay private per session (fractal delegation model): the
  parent plan is the single-writer plan of record; refinement crosses the
  boundary by prompt (step description + criteria) and returns as the worker
  report. The sidecar drill-down is read-only observability, not shared
  planning; the `scope` dimension remains the reserved seam for true
  in-thread shared plans if the fractal model ever proves insufficient.
- Pipeline simplification is explicitly out of scope until the plan layer has
  real-world signal.
