// ---- Row types matching SQLite schema (all strings/numbers, JSON as strings) ----

export type ProjectRow = {
  id: string;
  label: string;
  slug: string;
  is_personal: number;
  auto_dispatch: number;
  sources: string;             // JSON array of ProjectSource; defaults to '[]'
  /**
   * Per-project sandbox profile name. ``null`` = inherit the user-default
   * profile selected in launcher Settings. Profile names resolve to YAML
   * files under ``<config>/sandbox/<name>.yml``.
   */
  sandbox_profile: string | null;
  /** JSON-stringified ProjectConfig — see src/lib/project-to-config.ts (launcher). */
  config: string | null;
  due_date: string | null;     // epoch ms, stringified
  pinned_at: string | null;    // epoch ms, stringified
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
  blocked_by: string;                    // JSON array
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
  token_usage: string | null;           // JSON
  runs: string;                          // JSON array
  // Launcher-specific PR state
  pr_review: string | null;             // JSON array of PullRequestLink
  pr_merged_at: string | null;          // JSON map source id -> epoch ms
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
  pinned_at: string | null;    // epoch ms, stringified
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
  properties: string | null;  // JSON
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
  status: string;              // JSON
  created_at: string;
  branch: string | null;
  worktree_path: string | null;
  worktree_name: string | null;
  session_id: string | null;
  ticket_id: string | null;
  last_urls: string | null;   // JSON
};
