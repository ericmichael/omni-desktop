import { describe, expect, it } from 'vitest';

import { decideWorktreeAction } from './worktree';

describe('decideWorktreeAction', () => {
  // --- No worktree needed ---

  it('returns none when useWorktree is explicitly false, even with a branch', () => {
    expect(
      decideWorktreeAction({ useWorktree: false }, false, 'main')
    ).toEqual({ action: 'none' });
  });

  it('returns none when useWorktree is false and a worktree already exists on disk', () => {
    // Opt-out wins over reuse: flipping the flag off means "run direct" next time.
    expect(
      decideWorktreeAction(
        { useWorktree: false, worktreePath: '/tmp/wt', worktreeName: 'bold-fox' },
        true,
        'main'
      )
    ).toEqual({ action: 'none' });
  });

  it('returns none when branch is undefined', () => {
    expect(
      decideWorktreeAction({}, false)
    ).toEqual({ action: 'none' });
  });

  it('returns none when branch is empty', () => {
    expect(
      decideWorktreeAction({}, false, '')
    ).toEqual({ action: 'none' });
  });

  it('undefined useWorktree defaults to direct mode (opt-in required)', () => {
    expect(
      decideWorktreeAction({}, false, 'main')
    ).toEqual({ action: 'none' });
  });

  it('useWorktree: true still requires a branch', () => {
    expect(
      decideWorktreeAction({ useWorktree: true }, false)
    ).toEqual({ action: 'none' });
  });

  it('reuses a live worktree even when useWorktree is undefined (no orphaning)', () => {
    expect(
      decideWorktreeAction(
        { worktreePath: '/tmp/wt', worktreeName: 'bold-fox' },
        true,
        'main'
      )
    ).toEqual({ action: 'reuse', worktreePath: '/tmp/wt', worktreeName: 'bold-fox' });
  });

  // --- Create fresh worktree (useWorktree: true) ---

  it('returns create when no previous worktree exists', () => {
    expect(
      decideWorktreeAction({ useWorktree: true }, false, 'main')
    ).toEqual({ action: 'create' });
  });

  it('returns create when previous worktree path is set but directory is gone', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, worktreePath: '/tmp/old', worktreeName: 'old-tree' },
        false,
        'main'
      )
    ).toEqual({ action: 'create' });
  });

  it('returns create when worktreePath is set but worktreeName is missing', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, worktreePath: '/tmp/old' },
        true,
        'main'
      )
    ).toEqual({ action: 'create' });
  });

  it('returns create when worktreeName is set but worktreePath is missing', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, worktreeName: 'old-tree' },
        true,
        'main'
      )
    ).toEqual({ action: 'create' });
  });

  // --- Reuse existing worktree ---

  it('returns reuse when previous worktree exists on disk', () => {
    expect(
      decideWorktreeAction(
        { useWorktree: true, worktreePath: '/tmp/wt', worktreeName: 'bold-fox' },
        true,
        'main'
      )
    ).toEqual({ action: 'reuse', worktreePath: '/tmp/wt', worktreeName: 'bold-fox' });
  });

  it('reuse preserves exact path and name values', () => {
    const result = decideWorktreeAction(
      { useWorktree: true, worktreePath: '/data/worktrees/calm-owl', worktreeName: 'calm-owl' },
      true,
      'feat/x'
    );
    expect(result).toEqual({
      action: 'reuse',
      worktreePath: '/data/worktrees/calm-owl',
      worktreeName: 'calm-owl',
    });
  });

  it('creates a worktree when the branch is inherited externally', () => {
    expect(
      decideWorktreeAction({ useWorktree: true }, false, 'initiative-branch')
    ).toEqual({ action: 'create' });
  });
});
