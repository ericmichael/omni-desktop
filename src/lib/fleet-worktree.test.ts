import { describe, expect, it } from 'vitest';

import { decideWorktreeAction } from './fleet-worktree';

describe('decideWorktreeAction', () => {
  // --- No worktree needed ---

  it('returns none when useWorktree is false', () => {
    expect(
      decideWorktreeAction({ useWorktree: false, branch: 'main' }, false)
    ).toEqual({ action: 'none' });
  });

  it('returns none when useWorktree is undefined', () => {
    expect(
      decideWorktreeAction({ branch: 'main' }, false)
    ).toEqual({ action: 'none' });
  });

  it('returns none when branch is not set', () => {
    expect(
      decideWorktreeAction({ useWorktree: true }, false)
    ).toEqual({ action: 'none' });
  });

  it('returns none when branch is empty', () => {
    expect(
      decideWorktreeAction({ useWorktree: true, branch: '' }, false)
    ).toEqual({ action: 'none' });
  });

  // --- Create fresh worktree ---

  it('returns create when no previous worktree exists', () => {
    expect(
      decideWorktreeAction({ useWorktree: true, branch: 'main' }, false)
    ).toEqual({ action: 'create' });
  });

  it('returns create when previous worktree path is set but directory is gone', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, branch: 'main', worktreePath: '/tmp/old', worktreeName: 'old-tree' },
        false // directory doesn't exist
      )
    ).toEqual({ action: 'create' });
  });

  it('returns create when worktreePath is set but worktreeName is missing', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, branch: 'main', worktreePath: '/tmp/old' },
        true
      )
    ).toEqual({ action: 'create' });
  });

  it('returns create when worktreeName is set but worktreePath is missing', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, branch: 'main', worktreeName: 'old-tree' },
        true
      )
    ).toEqual({ action: 'create' });
  });

  // --- Reuse existing worktree ---

  it('returns reuse when previous worktree exists on disk', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, branch: 'main', worktreePath: '/tmp/wt', worktreeName: 'bold-fox' },
        true
      )
    ).toEqual({ action: 'reuse', worktreePath: '/tmp/wt', worktreeName: 'bold-fox' });
  });

  it('reuse preserves exact path and name values', () => {
    const result = decideWorktreeAction(
      { useWorktree: true, branch: 'feat/x', worktreePath: '/data/worktrees/calm-owl', worktreeName: 'calm-owl' },
      true
    );
    expect(result).toEqual({
      action: 'reuse',
      worktreePath: '/data/worktrees/calm-owl',
      worktreeName: 'calm-owl',
    });
  });
});
