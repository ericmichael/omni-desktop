# Plan: Resident Agents — a roster of named, persistent work agents

> Status: **IMPLEMENTED** 2026-07-22 (workstreams 1–6; workstream 7 rides
> the existing mcp-tool-identity plan). See "Implementation notes" at the
> bottom for what shipped and the deviations. Pattern source: Weirbrook
> (`~/code/omniagents_game`), the omniagents village game whose NPC
> substrate soak-tested every mechanism this plan ports. Model tiering /
> cognitive LOD is **explicitly out of scope** — see Out of scope.

## Goal

A small roster of **named, specialized, resident agents** — colleagues,
not request handlers. Each roster member has a stable identity (persona +
specialization), a durable editable memory earned by working with the
user, and **one persistent session** that receives the world as deltas
("wakeup pings") instead of being re-assembled per request. Agents wake on
events (mention, DM, assignment, schedule), act through tools, owe nothing
per turn (silence is a legal outcome), talk to each other through
human-readable digest channels with pacing budgets, delegate through
verified tickets, and end the day with a reflection ritual that distills
the session into curated durable memories.

The thesis, in one line: the industry's Slack/Teams agents are
request-shaped (assemble context → run → discard); Weirbrook proved the
resident shape (persist → ping deltas → pull state → distill nightly) is
cheaper, saner, and produces agents that feel like staff. Its measured
evidence: re-rendering full state each turn was 68% of stored context;
one unpaced gossiping agent pair consumed 34 of 53 wakeups; 12 concurrent
dawn wakeups browned out the provider. Every mechanism below exists
because a soak run demanded it.

## Why this fits the existing architecture

Most of the substrate already exists; this plan adds the roster, memory,
channel, and ritual layers on top of it.

- **The wakeup pipeline is already framework-side.** omniagents
  `core/autonomy/wakeup.py`: `service.enqueue_notification(role=
  "assistant")` → `_notification_flusher` batches → `start_run(
  prompt_role="assistant")` — the agent resumes from full history and
  reads the wakeup as *noticing*, not as being addressed by a fake user.
  The launcher already uses this path for background-job completions.
  `schedule_wakeup` (self-scheduled recurring wakeups) and the
  idle-trigger scheduler also already exist.
- **Sessions are not bound to columns.** `ProcessManager` keys
  `AgentProcess` by arbitrary string id — `"chat"` and `"global"` are
  precedents. A reserved `agent:<rosterId>` id per roster member is the
  same move. Server mode's `persistentSessions` keeps them alive across
  reconnects.
- **Parking is the existing snapshot machinery.** `omni serve`'s
  `--snapshot-dir` / `--session-id` / `--container-id` resume flow means
  an idle resident agent can be fully stopped and later rehydrated warm.
- **Verified delegation already exists as tickets.** `TicketMachine`
  enforces phases; `omni-projects` MCP tools give agents ticket CRUD. No
  new escrow mechanism is needed — a ticket *is* the game's commission:
  posted, claimed, and completion-verified outside the model's beliefs.
- **Scheduled rituals are Routines.** The morning sweep and nightly
  reflection are scheduled wakeups, a shape the launcher already runs.
- **Per-agent identity on MCP calls** aligns with the existing
  mcp-tool-identity / phase-10 identity plans (`get_current_principal`):
  a resident agent acts *as itself*, so its tickets, comments, and inbox
  items are attributable.

## Architecture decisions (the calls made)

### Identity and roster

- **A roster member is data, not code**: a launcher-store record
  `{ id, name, role, personaText, profileId, channels[], enabled }`
  plus a durable-memory list (below). Store schema bump + migration.
- **Persona is prior, memory is posterior.** The persona file is shipped
  identity — role, voice, doctrine, specialization. Durable memories are
  earned facts that may *override* persona (Weirbrook: "priors, not
  rules"). Persona text is user-editable in the UI.
- **Persona + durable memories travel as session variables** into
  `omni serve`; the omni-code instruction template renders them (one
  template change product-side, mirroring how skills are injected).
  First wakeup of each day additionally renders the memory block in the
  ping (the day-session opener), exactly as the game does.

### Sessions, compaction, and the daily ritual

- **One session per agent per calendar day**, id
  `<rosterId>-<YYYY-MM-DD>`, on the agent's persistent `omni serve`
  process. NOT one infinite ever-compacted session: summary-of-summary
  degrades uncontrollably. Continuity across days lives in durable
  memory, not transcript.
- **Intraday compaction** is the framework's existing session compaction
  (threshold-based, `context_summary` markers) — already what omni-code
  ships. No new mechanism.
- **Nightly reflection** runs at the day boundary (first wakeup after
  midnight, or at parking if the agent parks past it): one final turn ON
  the day session — it sees the whole compacted day, not a digest — that
  produces up to 3 durable memory lines plus `forget N` retractions for
  long-held memories proven wrong. The reflection prompt ports
  Weirbrook's `reflect_instructions.md` filter ("will tomorrow-you act
  differently because of this line?"), rewritten for work: commitments
  made, decisions and rationale, what failed and why, preferences
  learned about the user, prices/names/numbers kept exact.
- **v1 reflection output is a fenced block parsed by the launcher**
  (Weirbrook's prose fallback, which its tests proved workable). A
  `keep_memories` terminal tool is a later refinement — it requires a
  framework-side tool, and v1 must not block on that.
- **Retraction removes by value, not index** (the game's fix: instant
  promotions can land while the reflection LLM is thinking).
- **Some events skip reflection and write durable memory immediately**:
  explicit user corrections/feedback, accepted decisions, standing
  instructions. The nightly summarizer is never trusted with a
  commitment (Weirbrook: "political wounds are durable the moment they
  land").
- **Open tasks carry over at the day boundary; completed ones graduate**
  — the agent's task list (omni-code task semantics) is pruned at dawn.

### Wakeups, events, and pacing

- **The ping is a delta, never a state dump**: timestamp, why you woke,
  the batched events, unread channel rows since your cursor, and (first
  wakeup only) durable memories. Everything else is pull-based — the
  agent reads live state through its existing tools. This is the 68%
  lesson; it is the plan's load-bearing cost decision, and with model
  tiering excluded it is the *only* cost mechanism, so it is
  non-negotiable.
- **Nothing is owed per turn.** The wakeup rendering ends with the
  no-obligation contract (ported from `harness_preamble.md`): act if the
  moment needs it, otherwise end the turn. Channel digests are worded to
  bias silence ("answer only if it concerns you or adds something new").
- **Event classification, two kinds only** (launcher-side router):
  - `WAKE_NOW`: direct mention, DM to this agent, ticket assigned,
    approval requested of it, its own scheduled wakeup, day boundary.
    Delivered immediately via `enqueue_notification`.
  - Everything else (channel posts, FYI events, watched activity) never
    wakes anyone — it lands as cursor-tracked digest rows on the next
    natural wakeup.
- **Events queue while an agent is thinking or parked**; one wakeup
  delivers the whole batch. A `thinking` flag prevents double-starts
  (the game's `NpcState` pattern).
- **Agent↔agent DM threads carry a round budget** (count-based, ported
  verbatim from Weirbrook because it is speed-invariant): from round 4
  the ping stops urging a reply ("a closer needs no answer"), rounds 5–6
  stretch the delivery gap, past 6 the thread goes pen-pal — rows still
  land in digests but wake nobody until a long silence resets it. Only a
  *human's* message always wakes immediately. This ships in v1: it is
  the fix for the first pathology any multi-agent channel hits.
- **A global concurrency gate on simultaneous agent runs** (default 4,
  configurable) — the dawn-brownout fix. Queued wakeups keep the agent
  marked thinking.
- **No lull heartbeat.** Work agents are proactive through Routines
  (scheduled wakeups they or the user set), not an idle tick. This
  replaces the game's `lull` with a mechanism the launcher already has.

### Channels and observability

- **v1 channels**: one `#team` channel (all roster agents + the user)
  plus per-pair DM threads, stored launcher-side (a `ChannelManager`
  beside `ProjectManager`, `store:changed`-broadcast like everything
  else). Ticket comments remain the per-ticket thread and flow into
  digests for the ticket's assignee.
- **All agent↔agent traffic is human-readable and surfaced in the UI.**
  The chat log *is* the observability instrument — the audit surface is
  the product surface. No hidden agent-to-agent function calls for
  coordination; if agents coordinate, it happens in a channel the user
  can read.
- **UI**: a `Team` rail tab following the rail-tab convergence skeleton
  (PageHeader + 320px master-detail): roster list with status
  (parked / thinking / active, last wakeup, reason), the persona/memory
  editor per agent, and the channel feed.

### Lifecycle

- **Resident ≠ always running.** An agent with no pending `WAKE_NOW`
  events and no near-term scheduled wakeup parks after an idle window:
  process stopped, container snapshotted, session already durable on
  disk. A queued `WAKE_NOW` event (or due schedule) unparks it through
  the normal serve resume flow. Parking is invisible to the agent — the
  ping shape is identical (the game's "brains never see LOD" invariant,
  applied to the only tiering we keep).
- **Reflection runs before a park that crosses the day boundary**, so a
  parked agent never wakes owing yesterday's ritual mid-task.

### Delegation

- **Delegation is a ticket, full stop.** Agent A creates a ticket
  assigned to agent B (existing MCP tools); assignment is B's `WAKE_NOW`
  event; completion is verified by the ticket lifecycle, not by A
  believing B's message. Inbox items cover the lighter "for whoever
  picks it up" case (the notice board). No new contract mechanism in v1.
- **Policy lives in tool gating, never prompts** (Weirbrook: "the world
  enforces nothing beyond what your tools do"). Each roster member's
  capability set is its sandbox profile + client-tool scope — the same
  filtering `buildClientToolHandler` already does per surface.

## Workstreams

1. **Roster + identity** — store schema (records + durable memory lists,
   migration), persona editing, session-variable plumbing into
   `AgentProcess.start`, omni-code instruction-template change to render
   persona/memory variables.
2. **Resident lifecycle** — reserved `agent:<id>` process ids in
   `ProcessManager`, park/unpark on the snapshot machinery, idle-window
   policy, the global run-concurrency gate.
3. **Event router + pings** — launcher-side `WAKE_NOW` classification,
   per-agent pending queues + thinking flag, digest cursors, ping
   renderer (delta-only; memory block on day's first wakeup), delivery
   via the existing `enqueue_notification` path.
4. **Channels + pacing** — `ChannelManager` (`#team`, DM threads),
   digest rendering with speaker attribution, the per-pair round budget,
   ticket-comment digest integration.
5. **Memory + rituals** — durable memory store with value-based
   `forget`, immediate-durable event writes, reflection scheduling at
   day boundary/park, reflect prompt + fenced-block parser, task
   carryover at dawn.
6. **Team rail tab** — roster master-detail, status/trace feed, channel
   viewer, persona/memory editors.
7. **Identity on tools** — per-agent principal for MCP calls so tickets,
   comments, and inbox items are attributable (rides the existing
   mcp-tool-identity plan; this workstream is alignment, not invention).

Workstreams 1–3 are the vertical slice: one roster agent that wakes on an
assigned ticket, works, and parks. 4–5 make it a staff. 6–7 make it a
product.

## Test plan

- Unit: event classification (WAKE_NOW vs digest), digest cursor
  advancement, round-budget state machine (urge → winding-down →
  pen-pal → reset), reflection parser incl. `forget N` by value,
  day-boundary task carryover, park/unpark decision logic. All pure
  functions in `src/lib/`, per house style.
- Integration (manager-level, through the electron shim): wakeup
  batching while thinking, queue-then-unpark delivery, concurrency gate
  under a burst of simultaneous events, reflection firing exactly once
  per day boundary.
- Soak (manual, the Weirbrook method): two roster agents + the user in
  `#team` for a simulated day; assert no unbudgeted reply loop, no
  wakeup without a `WAKE_NOW` cause or due schedule, memory lines land
  and retract. The channel log is the evidence artifact.

## Out of scope (v1)

- **Model tiering / cognitive LOD** — explicitly deferred. Every agent
  runs the user's configured model. If attention-based economics return
  later, they control *wakeup frequency and event immediacy only*, never
  model choice — and the ping architecture is where v1's cost control
  lives instead.
- A `keep_memories` terminal tool (framework change; fenced-block parse
  ships first).
- Framework-side extraction of the manager layer (batching, digests,
  pacing, reflection) into omniagents where the game and launcher could
  share it — the right long-term home, but v1 proves the shape
  launcher-side first.
- Elastic/anonymous agent pools, agent-created agents, cross-tenant
  rosters.

## Assumptions

- Roster size is small (≈2–6); nothing is designed for dozens.
- Resident agents run on normal sandbox profiles; a headless agent needs
  no column/webview (the `"global"` agent precedent).
- Day boundary = local midnight; "first wakeup after" is an acceptable
  reflection trigger (no dedicated cron needed).
- Channel storage does not need its own DB in v1; the launcher store +
  existing persistence is sufficient at roster scale.

## Implementation notes (what shipped, 2026-07-22)

- **Pure core**: `src/lib/resident-agent.ts` (+ tests) — event
  classification, day sessions, the round budget, the outgoing-message
  protocol, ping/reflect/AGENTS.md renders, reflection parsing with
  value-based `forget`, digest cursors.
- **Manager**: `src/main/resident-agent-manager.ts` — roster CRUD,
  per-agent queues + serialized task chains, the delivery pipeline
  (debounce → reflect-if-day-rolled → run slot → ensure process →
  watcher WS → `enqueue_message` role=assistant), agent↔agent DM
  budget with per-pair delivery slots, nightly reflection, 10-min idle
  park with warm-reattach handles, 4-slot run gate, `resident:*` IPC.
  Wired in both `src/main/index.ts` and per-tenant `src/server/managers.ts`.
- **UI**: `src/renderer/features/Residents/` — the **Agents** rail tab
  (LayoutMode `'agents'`; the `team:*` IPC namespace was already taken by
  cloud teams, hence `resident:*`): 320px master-detail, roster rows with
  live state badges, #team + per-agent DM feeds with composers, persona
  editor, durable-memory list with pruning, wake/enable/delete.
- **Watcher wire contract**: one persistent WS per running agent —
  `server_call session.ensure` attaches the channel; `enqueue_message`
  (`role: "assistant"`, `trigger_run: true`) delivers pings on the same
  pipeline omniagents' notification flusher uses; `run_started`/
  `message_output`/`run_end` track thinking state and capture the reply;
  `tool_approval_requested` is auto-declined with an explanation and
  surfaced as a `resident:attention` event.
- **Speech is CLIENT TOOLS** (replaced the original addressed-line parse
  outright — no fallback): `post_team(text)` and `dm(to, text)`,
  declared per session via `variables.client_tools` on the watcher's
  `session.ensure` (connection-scoped; re-declared each connect) and
  fulfilled by the watcher over `client_request`/`client_response`
  (`function: "tool.call"`, `args: {tool, arguments}`). This restores
  the game's speech-as-action semantics: mid-turn delivery, corrective
  `Error: …` tool results the model retries on in-run (bad recipient
  lists the valid ids), the ≤3-per-turn budget pushed back in the moment
  ("enough said"), no PASS sentinel (silence = not calling the tools),
  and identical behavior in wakeup- and user-driven runs. Identity is
  implicit and unforgeable — the call arrives on the agent's own watcher
  channel. Safety: `safe_tool_overrides` (additive) on each wakeup
  enqueue, plus the watcher auto-APPROVES its own tool names on
  `tool_approval_requested` (still auto-declining everything else).
  Double-fulfillment guard: `client_request` broadcasts to every
  attached channel and a handler-less OmniAgentsApp nacks `tool.call`,
  so the embedded session view passes a swallow-handler (never resolves)
  — the watcher is the single fulfiller. The agent's final reply is now
  private notes-to-self; only tools are heard.
- **Identity injection**: persona + durable memories + conduct rules are
  written to `<workspace root>/Agents/<id>/AGENTS.md`, which omni-code
  already injects by convention — zero cross-repo changes; applied on
  next session start.
- **Project assignment** (added same day): `ResidentAgent.projectId` —
  assigned agents launch with the project's sources, per-project profile
  layer, and git credentials via the normal `ProcessManager` project
  path, plus the agent home appended as a `home` mount
  (`AgentProcessStartOptions.extraSources`, deduped by directory) so the
  AGENTS.md identity and private files travel with the agent. The
  identity file names the assignment and the home mount. Changing
  project or sandbox parks the agent and drops the warm-reattach handle;
  the next wakeup starts with the new configuration. `projectId: null`
  in an update unassigns.
- **Sandbox per agent**: resolution is agent override → assigned
  project's profile → user default; new agents default to **`devbox`**
  (an autonomous wakeup-driven process should not silently inherit
  `host`). Surfaced in the create form and detail pane via the standard
  `SandboxPicker`, with the project selector beside it.
- **UX rework (same day)** — talking to an agent is its **real session**,
  not a hand-rolled chat feed: the detail pane's Session tab mounts the
  same `OmniAgentsApp` every chat/code column renders (full transcript,
  tool activity, approvals, input) on the agent's process, via
  `resident:ensure-session` (main wakes the process, attaches its
  watcher first so thinking-state and park re-arming cover user-driven
  runs, ensures the day session, returns `{sessionId, uiUrl}`; the
  GlobalAgentPanel pattern). The channel UI shrank to what is genuinely
  new: an **Activity** view showing ALL channel traffic — #team plus
  every agent↔agent DM thread, labeled — with an unread counter; the
  composer posts to #team. Also landed: `resident:attention` now
  surfaces as warning toasts deep-linking into the tab; the immutable
  `@id` is shown in the detail header and previewed at create; Settings
  tab uses the explicit save/dirty/error idiom (name/role/persona all
  editable); durable memories can be added, not just pruned; deleting an
  agent prunes its DM threads; status re-syncs on WS reconnect;
  keyboard focus outlines restored on rows.
- **Weirbrook parity pass (same day)** — four guards ported after a
  side-by-side with the game's village chat: (1) digest rows capped at 8
  per channel, newest kept, omission count reported in the ping, and
  read digest rows now logged to episodic so reflection can recall them;
  (2) the eventual-delivery guarantee restored — unread digest older
  than 4h triggers ONE `catch_up` wakeup per backlog (the cursor
  advance clears the condition; this replaces the lull heartbeat the
  plan had dropped without an explicit decision); (3) per-turn speech
  budget — at most 3 parsed messages per reply, overflow dropped and
  reported back as a NOTICES line on the next ping; (4) the town-crier
  rule — attention incidents also land in the channel log as `system`
  rows (user-facing only; never in agent digests), so the Activity feed
  is the complete record.
- **Named channels** (replaced the single-#team model): user-created
  channels (`residentChannelDefs`, slug ids; `team`/`system`/`user`/
  `dm:*` reserved; agent-id collisions refused) sit beside the built-in
  `#team`. **Membership is Slack-style** (`ResidentChannelDef.members`;
  absent = open to all, `#team` always all-hands, the user implicitly in
  everything): only members are woken by posts, see the channel in
  digests, or may post to it — a mention in a channel you're not in does
  NOT wake you, and `post_channel`'s corrective error lists *your*
  channels. Cursors advance past non-member rows so a later join never
  replays history. Member management = clickable agent chips atop each
  channel's feed. Wake semantics
  are uniform across channels: user post → `channel_user` wake (bias to
  silence) or `mention`; agent post → `channel_post` digest. Agents
  speak with `post_channel(channel, text)` — the tool description lists
  live channels, unknown-channel errors list them too. Digests group
  per channel in the ping (`## NEW IN #<id>`); the 8-row cap is
  per-channel. UI: channel rows in the master list (create inline,
  hover-delete for non-team; delete prunes rows), per-channel feed
  views, Activity remains the all-traffic audit view.
- **Day structure** (from the lifecycle comparison with the game): (1)
  the **morning beat** — one `day_start` wakeup per agent per day at the
  first 5-min tick past 08:00 local, giving the day a planning beat
  (memories arrive first-of-day, overnight digests ride along).
  Suppressed for today on launcher boot so a mid-day restart never wakes
  the roster; new agents get their first morning tomorrow. (2)
  **Self-scheduling** — a `schedule(minutes, note)` client tool (the
  game's `plan()`), launcher-side because alarms must survive parking
  (a serve-process alarm dies with the container): alarms persist in
  `residentAlarms`, a 60s sweep fires due ones as WAKE_NOW `scheduled`
  events with the note rendered back ("you told yourself: …"), pending
  ones render in every ping under UPCOMING REMINDERS. Guards: 1 min–1
  week horizon, ≤10 open per agent, exempt from the speech budget.
  Parking stays imposed and invisible (no `day_end`/chosen sleep — a
  cost policy, not a decision), and no lull heartbeat.
- **Not shipped**: ticket-comment digest integration, per-agent MCP
  principal (workstream 7 — rides the mcp-tool-identity plan), the
  `keep_memories` terminal tool (fenced block ships, as planned).
