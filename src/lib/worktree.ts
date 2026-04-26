/**
 * Pure worktree decision logic — extracted for testability.
 */

export type WorktreeDecision =
  | { action: 'reuse'; worktreePath: string; worktreeName: string }
  | { action: 'create' }
  | { action: 'none' };

/**
 * Decide whether to reuse an existing worktree, create a new one, or skip.
 *
 * Default is direct mode (`none`) — worktrees are explicit opt-in via
 * `useWorktree === true`. The one exception: a ticket with a live worktree
 * already on disk keeps reusing it regardless of flag state, so older tickets
 * created before the opt-in flip aren't orphaned mid-flight. An explicit
 * `useWorktree === false` still routes to `none` in all cases (the UI
 * disables that toggle while a worktree is live, so this only fires when
 * the data was edited directly or the worktree disappeared).
 *
 * @param ticket - useWorktree toggle; worktreePath/worktreeName persist reuse
 * @param worktreeExists - whether the existing worktree path exists on disk
 */
export const decideWorktreeAction = (
  ticket: {
    useWorktree?: boolean;
    worktreePath?: string;
    worktreeName?: string;
  },
  worktreeExists: boolean,
  effectiveBranch?: string
): WorktreeDecision => {
  if (ticket.useWorktree === false) {
    return { action: 'none' };
  }

  // Reuse a still-live worktree even when useWorktree is undefined —
  // otherwise flipping the default would orphan worktrees from pre-existing tickets.
  if (ticket.worktreePath && ticket.worktreeName && worktreeExists) {
    return { action: 'reuse', worktreePath: ticket.worktreePath, worktreeName: ticket.worktreeName };
  }

  if (ticket.useWorktree !== true) {
    return { action: 'none' };
  }
  if (!effectiveBranch) {
    return { action: 'none' };
  }
  return { action: 'create' };
};

/**
 * A claim on a filesystem workspace. Two active supervisors holding claims
 * that collide would write to the same directory / git index concurrently,
 * so the second one must be rejected at preflight.
 */
export type WorkspaceClaim =
  | { kind: 'direct'; path: string }
  | { kind: 'worktree'; path: string };

/**
 * Resolve the workspace a ticket will occupy when its supervisor is running.
 * Returns `null` when the ticket has no local claim (remote project,
 * missing workspaceDir, etc.) — those never collide with anything local.
 *
 * Direct mode: `useWorktree === false` → the sandbox mounts `workspaceDir`
 * directly, so the claim is on that exact path.
 *
 * Worktree mode: a live `worktreePath` persists the claim across restarts.
 * A ticket that hasn't provisioned yet has no claim — the name it picks
 * will be fresh and collision-proof.
 */
export const resolveWorkspaceClaim = (
  ticket: {
    useWorktree?: boolean;
    worktreePath?: string;
  },
  workspaceDir: string | undefined
): WorkspaceClaim | null => {
  if (!workspaceDir) {
    return null;
  }
  if (ticket.useWorktree === false) {
    return { kind: 'direct', path: workspaceDir };
  }
  if (ticket.worktreePath) {
    return { kind: 'worktree', path: ticket.worktreePath };
  }
  return null;
};

/** True when two claims point at the same filesystem path. */
export const claimsCollide = (a: WorkspaceClaim, b: WorkspaceClaim): boolean => {
  return a.path === b.path;
};
