# Attention-Centric IA — Home · Inbox · Work

## Summary

Split the container-centric "Projects" tab into three attention-centric rail
destinations (Home = mission control, Inbox = capture/triage, Work = all tasks

- projects). Add a Jira-style `category` field to pipeline columns so a global
  Work view can exist without touching the per-project agent state graphs.
  Rename user-facing "ticket" → "task". Fix the navigation model (real history
  stack, no state reset on rail clicks).

**Design note:** Projects does _not_ get its own rail tab. It is the Work
tab's sidebar ("All work" row on top, project list below). Two reasons: (a) a
separate Projects tab creates two hosts for the same task/project/page views
with two navigation stacks — the single-host architecture (`Tickets.tsx` =
sidebar + view switch) carries over cleanly if Work owns both; (b) the mobile
bottom bar can't fit seven tabs. Mobile is exactly
**Home · Inbox · Work · Chat · Settings**.

## 1. Navigation model

**Rail (`LayoutMode`)** — add `'home' | 'inbox' | 'work'`, drop `'projects'`.
Desktop order: Home, Inbox, Work, Chat, Routines, Dashboards (enterprise),
spacer, Settings. Mobile bar: Home, Inbox, Work, Chat, Settings inline.
Icons: `Home24`, `MailInbox24`, `TaskListSquareLtr24`, Chat as-is; Routines
gets its own icon (`CalendarClock24`) — it previously duplicated Dashboards'.
The inbox count badge moves from the old Projects tab to the Inbox tab.

**Rail clicks switch tabs only.** The `goToDashboard()` reset in
`app/Sidebar.tsx` is deleted — each tab resumes exactly where it was (this is
what `MainContent`'s keep-mounted design already promises).

**View state** — the `$ticketsView` monolith splits:

- `$inboxView: { selectedItemId: InboxItemId | null }` — inbox is
  self-contained at rail level.
- Work view union (replaces the old one):
  - `{ type: 'all' }` — global task list (new; the default)
  - `{ type: 'project'; projectId; tab: 'home' | 'board' | 'pages' | 'settings' }`
    (labels render as Home · Work · Docs · Settings)
  - `{ type: 'page' | 'milestone' | 'ticket' }` — as today
- Home needs no view atom (single screen).

**History: a real stack.** `$previousTicketsView` becomes a bounded stack
(50 entries). Every navigation pushes the outgoing view; back pops. This makes
task→task→back work, which the single slot structurally can't. Cross-tab
jumps (Home card → task) set `layoutMode = 'work'` then navigate; they push
onto Work's stack like any other navigation.

## 2. Status categories

**`packages/projects-db` — next SQL migration:**

```sql
ALTER TABLE pipeline_columns ADD COLUMN category TEXT NOT NULL DEFAULT 'doing'
  CHECK(category IN ('todo','doing','done'));
-- backfill: per project, last column by sort_order → 'done', first → 'todo'
-- (in that order, so a single-column pipeline lands on 'done', preserving
-- the "last column = shipped" semantics), remainder stays 'doing'.
```

Also: `DEFAULT_COLUMNS`/`SIMPLE_COLUMNS` in `defaults.ts` gain explicit
categories; the repo row↔column mapping and `migrate-from-json` seeding carry
the field.

**Launcher:** `Column.category: ColumnCategory` (required — the migration
guarantees it), new `ColumnCategory = 'todo' | 'doing' | 'done'` in
`shared/types.ts`; `pipeline-defaults.ts` maps it through.

**Validation** — pure module `src/lib/pipeline-category.ts`, enforced at the
single write chokepoint (`ProjectManager.updatePipeline`, hit by both the
editor and the MCP `update_pipeline` tool) — _not_ against legacy data:

- ≥ 1 `todo`; exactly one `done`; `done` is the last column; categories
  non-decreasing (`todo* doing* done`).
- `validatePipelineCategories(columns): Result<void, string>`;
  `categoryOf(pipeline, columnId): ColumnCategory` (unknown id → `'doing'`).

**Positional terminal detection is replaced everywhere.** The
`columns[columns.length - 1]` / `terminalColumnIds` inference (previously in
`ProjectsDashboard`, `ProjectHome`, `WorkItemsList`, `home-rollup`) becomes
`category === 'done'`. One rule, declared not inferred.

**PipelineEditor** gains a per-column category picker with inline validation
errors on save. **The MCP contract does not change** — agents keep moving
tickets through columns by id and never see categories.

## 3. Derived attention

Pure module `src/lib/task-attention.ts`:

```ts
type AttentionReason = 'awaiting_input' | 'error' | 'agent_done_unresolved';
needsAttention(ticket: Ticket, category: ColumnCategory): AttentionReason | null
```

- `phase === 'awaiting_input'` → `'awaiting_input'`; `phase === 'error'` → `'error'`
- `phase === 'completed' && !ticket.resolution && category !== 'done'` →
  `'agent_done_unresolved'` (agent finished its run, human hasn't dispositioned)
- PR-ready signals are **deferred**: PR detection is a per-ticket async probe;
  no global data source yet. The reason type is extensible.

`groupTasks(...)` → `{ needsYou, doing, todo, done }`. Needs-you is an
overlay, not a category: a task appears in **Needs you** _instead of_ its
category group (no duplicates). Sorting: needsYou by `updatedAt` desc; doing
with active-phase first; todo by priority then `createdAt`; done by
`resolvedAt` desc, collapsed, windowed to 14 days in the global view.

## 4. Screens

**Home** (new `features/Home/`, reworked from `ProjectsDashboard`) — sections:

1. **Needs you** — task rows with project label + reason badge; calm
   "Nothing needs you." when empty.
2. **Running now** — active-phase tasks with live phase badges; header carries
   the WIP count as text ("2 of 3 agents running") — the big gauge is cut.
3. **Inbox** — top 3 active items + count, linking to the Inbox tab.
4. **This week** — pinned **projects only** (milestone pinning removed from
   UI; `pinnedAt` data retained). Cards keep next-up + Start. Pin suggestions stay.
5. **Shipped** — digest as before. Weekly-review banner + `WeekPlanDialog`
   stay, triggered from here.

Empty state gains real actions: **New project** (opens `ProjectCreateDialog`)
and **Capture a thought** (opens QuickCapture).

**Inbox tab** — `InboxView`/`InboxItemDetail` hosted at rail level, internal
Inbox/Later/Archive tabs unchanged. "Promote to ticket" → "Promote to task";
after promotion, fire a status toast "Promoted to task in _{project}_" with an
**Open** action — flow stays in the inbox (emptying mode).

**Work tab** (the renamed Tickets feature):

- **Sidebar**: "All work" row on top (replaces Home/Inbox rows), then the
  Projects section as before (+ New project, pins, counts).
- **All work** (new view): every task across projects from the persisted store
  snapshot (`store.tickets` — already global). Search (client-side over
  title+description), filter chips (project, needs-you, assignee), grouped
  **Needs you / Doing / To do / Done**. Each row: priority dot, title, project
  label, `"{Category} · {column label}"` badge from that project's pipeline,
  phase badge. "New task" opens a project picker popover, then creates and
  navigates.
- **Project shell tabs**: labels become `Home · Work · Docs · Settings`. The
  in-project list gains category grouping; the kanban board stays as the
  per-project pipeline visualization; its toggle is session-persisted per
  project instead of resetting on navigation.
- **Task detail**: copy pass, plus delete gets a `ConfirmDialog`.
- Milestones: unchanged structurally; milestone pin buttons removed.

**Copy pass** (user-facing strings only — code identifiers keep `Ticket`,
because `Task` already names the agent-process type and MCP tool names are an
agent-facing contract):

- ticket → task in every renderer string, aria-label, dialog, empty state.
- "Autopilot" buttons → "Start agent"; `WipLimitDialog` copy "tickets in
  progress" → "agents running".
- CommandPalette: update labels, add "Go to Home / Inbox / Work" commands.

## 5. Migrations

- **Launcher store** (next `project-migrations.ts` version):
  `layoutMode 'projects' → 'work'`; new-install default becomes `'home'`.
- **packages/projects-db**: the category migration in §2 (additive column —
  old builds ignore it, rollback-safe).

## 6. Test plan

- `pipeline-category.test.ts`: validation matrix (valid shapes; missing todo;
  two dones; done not last; non-monotonic), backfill rule incl. single-column
  → `done`.
- `task-attention.test.ts`: each reason; `resolution` suppresses; `done`
  category suppresses `agent_done_unresolved`; grouping overlay produces no
  duplicates; done windowing.
- `project-migrations.test.ts`: layoutMode step (old value, unset, already-new).
- projects-db migrate test: backfill on 1/2/5-column pipelines.
- Work state test: history stack push/pop/bound; existing tests updated for
  renamed labels.

## 7. Rollout slices

1. **Categories**: DB migration, types, validation lib, terminal-detection
   refactor, PipelineEditor picker. No IA change visible.
2. **Rail split**: Home/Inbox/Work tabs, view-state split, history stack,
   rail-click fix.
3. **All-work view**: global list + search/filters + grouping.
4. **Copy pass**: task/Start-agent strings, tab labels, task-delete confirm,
   promote toast.

## Assumptions

- Projects merged into Work's sidebar, not a sixth rail tab.
- UI-copy-only rename; `Ticket` stays in code and MCP.
- Three categories, no `review`; review-attention is derived. PR-based
  needs-you deferred.
- Single-column pipelines backfill to `done`; validation applies only to new
  pipeline saves.
- Milestone pinning removed from UI, data kept; kanban board kept per-project.
- Done group in All work windowed to 14 days.
