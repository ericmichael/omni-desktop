/**
 * Tests for worktree-ops.ts — worktree name generation and git repo detection.
 *
 * generateWorktreeName is tested for format/constraints.
 * checkGitRepo, createWorktree, removeWorktree use real tmpdir git repos.
 */
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getWorktreesDir so createWorktree/removeWorktree use our tmpdir
const worktreesTmpDir = mkdtempSync(join(tmpdir(), 'wt-tests-'));
vi.mock('@/main/util', () => ({
  getWorktreesDir: () => worktreesTmpDir,
}));

import { checkGitRepo, createWorktree, generateWorktreeName, removeWorktree } from '@/main/worktree-ops';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repoDir: string;

function initRepo(opts?: { bare?: boolean; withCommit?: boolean }) {
  repoDir = mkdtempSync(join(tmpdir(), 'worktree-test-'));
  execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
  if (opts?.withCommit !== false) {
    execSync('git commit --allow-empty -m "init"', { cwd: repoDir, stdio: 'ignore' });
  }
}

beforeEach(() => {
  repoDir = '';
});

afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// generateWorktreeName
// ---------------------------------------------------------------------------

describe('generateWorktreeName', () => {
  it('returns a string matching adjective-noun pattern', () => {
    const name = generateWorktreeName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('generates different names (non-deterministic, but statistically certain)', () => {
    const names = new Set(Array.from({ length: 20 }, () => generateWorktreeName()));
    // With 49 adjectives × 60 nouns = 2940 combinations, 20 draws should have no collisions
    expect(names.size).toBeGreaterThan(1);
  });

  it('contains exactly one hyphen', () => {
    const name = generateWorktreeName();
    expect(name.split('-')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// checkGitRepo
// ---------------------------------------------------------------------------

describe('checkGitRepo', () => {
  it('returns isGitRepo: false for a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-git-'));
    try {
      const info = await checkGitRepo(dir);
      expect(info.isGitRepo).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns isGitRepo: false for a non-existent directory', async () => {
    const info = await checkGitRepo('/tmp/does-not-exist-12345');
    expect(info.isGitRepo).toBe(false);
  });

  it('detects a valid git repo', async () => {
    initRepo();
    const info = await checkGitRepo(repoDir);
    expect(info.isGitRepo).toBe(true);
  });

  it('returns the current branch name', async () => {
    initRepo();
    const info = await checkGitRepo(repoDir);
    expect(info.isGitRepo).toBe(true);
    if (info.isGitRepo) {
      // Default branch is either "main" or "master" depending on git config
      expect(['main', 'master']).toContain(info.currentBranch);
    }
  });

  it('lists all branches', async () => {
    initRepo();
    execSync('git checkout -b feature-a', { cwd: repoDir, stdio: 'ignore' });
    execSync('git checkout -b feature-b', { cwd: repoDir, stdio: 'ignore' });

    const info = await checkGitRepo(repoDir);
    expect(info.isGitRepo).toBe(true);
    if (info.isGitRepo) {
      expect(info.branches).toContain('feature-a');
      expect(info.branches).toContain('feature-b');
      expect(info.branches!.length).toBeGreaterThanOrEqual(3); // main/master + feature-a + feature-b
    }
  });

  it('works with a repo that has no commits', async () => {
    initRepo({ withCommit: false });
    const info = await checkGitRepo(repoDir);
    // A repo with no commits may return isGitRepo: true or false depending
    // on how git handles it — the key thing is it doesn't throw
    expect(typeof info.isGitRepo).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// createWorktree / removeWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  it('creates a worktree directory and returns its path', async () => {
    initRepo();
    const name = 'test-worktree';
    const defaultBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();

    const worktreePath = await createWorktree(repoDir, defaultBranch, name);

    expect(worktreePath).toBe(join(worktreesTmpDir, name));

    // Verify git recognizes the worktree
    const output = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(output).toContain(name);

    // Cleanup
    await removeWorktree(repoDir, worktreePath, name);
  });
});

describe('removeWorktree', () => {
  it('removes the worktree and branch', async () => {
    initRepo();
    const name = 'removable-wt';
    const defaultBranch = execSync('git branch --show-current', { cwd: repoDir, encoding: 'utf8' }).trim();

    const worktreePath = await createWorktree(repoDir, defaultBranch, name);
    await removeWorktree(repoDir, worktreePath, name);

    // Worktree should no longer be listed
    const output = execSync('git worktree list', { cwd: repoDir, encoding: 'utf8' });
    expect(output).not.toContain(name);

    // Branch should be deleted
    const branches = execSync('git branch --list', { cwd: repoDir, encoding: 'utf8' });
    expect(branches).not.toContain(`ticket/${name}`);
  });

  it('does not throw for non-existent worktree', async () => {
    initRepo();
    // Should not throw — removeWorktree catches errors internally
    await removeWorktree(repoDir, '/tmp/nonexistent-wt', 'nonexistent');
  });
});
