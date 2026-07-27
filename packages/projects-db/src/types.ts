// ---- Row types matching SQLite schema (all strings/numbers, JSON as strings) ----

export type ProjectRow = {
  id: string;
  label: string;
  slug: string;
  is_personal: number;
  auto_dispatch: number;
  sources: string; // JSON array of ProjectSource; defaults to '[]'
  /**
   * Per-project sandbox profile name. ``null`` = inherit the user-default
   * profile selected in launcher Settings. Profile names resolve to YAML
   * files under ``<config>/sandbox/<name>.yml``.
   */
  sandbox_profile: string | null;
  /** JSON-stringified ProjectConfig — see src/lib/project-to-config.ts (launcher). */
  config: string | null;
  due_date: string | null; // epoch ms, stringified
  pinned_at: string | null; // epoch ms, stringified
  created_at: string;
  updated_at: string;
};

export type ColumnRow = {
  id: string;
  project_id: string;
  label: string;
  description: string | null;
  sort_order: number;
  gate: number;
  max_concurrent: number | null;
  workflow: string | null;
  /** Status category: 'todo' | 'doing' | 'done'. NOT NULL with DEFAULT 'doing'. */
  category: string;
};

export type TicketRow = {
  id: string;
  project_id: string;
  milestone_id: string | null;
  column_id: string;
  title: string;
  description: string;
  priority: string;
  branch: string | null;
  blocked_by: string; // JSON array
  resolution: string | null;
  resolved_at: string | null;
  archived_at: string | null;
  column_changed_at: string | null;
  // Launcher-specific (v2)
  use_worktree: number;
  worktree_path: string | null;
  worktree_name: string | null;
  supervisor_session_id: string | null;
  phase: string | null;
  phase_changed_at: string | null;
  supervisor_task_id: string | null;
  token_usage: string | null; // JSON
  runs: string; // JSON array
  // Launcher-specific PR state
  pr_review: string | null; // JSON array of PullRequestLink
  pr_merged_at: string | null; // JSON map source id -> epoch ms
  // Teams (SQLite v9 / PG v6) — assigned member's principal id, or null
  assignee: string | null;
  created_at: string;
  updated_at: string;
};

export type CommentRow = {
  id: string;
  ticket_id: string;
  author: string;
  content: string;
  created_at: string;
};

export type MilestoneRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  branch: string | null;
  brief: string | null;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  pinned_at: string | null; // epoch ms, stringified
  created_at: string;
  updated_at: string;
};

export type PageRow = {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  sort_order: number;
  is_root: number;
  kind: string;
  properties: string | null; // JSON
  created_at: string;
  updated_at: string;
};

export type InboxRow = {
  id: string;
  title: string;
  note: string | null;
  project_id: string | null;
  status: string;
  later_at: string | null;
  promoted_to: string | null; // JSON
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: string;
  project_id: string;
  task_description: string;
  status: string; // JSON
  created_at: string;
  branch: string | null;
  worktree_path: string | null;
  worktree_name: string | null;
  session_id: string | null;
  ticket_id: string | null;
  last_urls: string | null; // JSON
};

// ---- Resident agents (docs/residents-in-projects-db-plan.md) ----

export type ResidentRow = {
  id: string;
  name: string;
  role: string;
  persona_text: string;
  profile_name: string | null;
  project_ids: string; // JSON string[]
  /** Local hour (0-23) of the daily morning beat; NULL = beat disabled. */
  morning_hour: number | null;
  enabled: number;
  /** Workspace superuser (0|1): declares the workspace/column client tools. */
  superuser: number;
  created_at: string;
};

export type ResidentMemoryRow = {
  agent_id: string;
  /** Upsert key — `remember(key, …)` replaces, `forget(key)` retracts. */
  key: string;
  text: string;
  at: string;
};

export type ResidentChannelRow = {
  id: string;
  description: string | null;
  /** JSON string[] of member roster ids; NULL = open to every agent. */
  members: string | null;
  created_at: string;
};

export type ResidentMessageRow = {
  id: number;
  /** 'team' | named channel id | 'dm:<a>:<b>' | 'system'. */
  channel: string;
  /** 'user' | 'system' | roster id. */
  from_id: string;
  from_name: string | null;
  text: string;
  at: string;
  /** Root message id of the thread (pre-normalized to the root on write). */
  reply_to: number | null;
};

export type ResidentAlarmRow = {
  id: number;
  agent_id: string;
  /** When the alarm fires. */
  at: string;
  note: string;
  created_at: string;
};

export type HandbookRow = {
  body: string;
  updated_at: string;
  /** Principal that last edited ('agent:<id>' for residents, null for the user). */
  updated_by: string | null;
};
