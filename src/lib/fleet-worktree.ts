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
 * @param ticket - must include useWorktree, branch, worktreePath, worktreeName
 * @param worktreeExists - whether the existing worktree path exists on disk
 */
export const decideWorktreeAction = (
  ticket: {
    useWorktree?: boolean;
    branch?: string;
    worktreePath?: string;
    worktreeName?: string;
  },
  worktreeExists: boolean
): WorktreeDecision => {
  // Worktrees disabled or no branch configured
  if (!ticket.useWorktree || !ticket.branch) {
    return { action: 'none' };
  }

  // Ticket has a persisted worktree and it still exists on disk — reuse
  if (ticket.worktreePath && ticket.worktreeName && worktreeExists) {
    return { action: 'reuse', worktreePath: ticket.worktreePath, worktreeName: ticket.worktreeName };
  }

  // Need a fresh worktree
  return { action: 'create' };
};
