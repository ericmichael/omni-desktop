/**
 * Tests for pr-merge.ts — exercises checkMerge + mergeBranch against real
 * tmpdir git repos with real divergent history.
 */
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkMerge, mergeBranch } from '@/lib/pr-merge';

let repoDir: string;

const git = (...args: string[]): string =>
  execSync(`git ${args.join(' ')}`, { cwd: repoDir, encoding: 'utf8' }).trim();

const commit = (file: string, content: string, msg: string): void => {
  writeFileSync(join(repoDir, file), content);
  git('add', file);
  git('commit', '-m', JSON.stringify(msg));
};

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'pr-merge-test-'));
  execSync('git init -b main', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: repoDir, stdio: 'ignore' });
  commit('README.md', 'hello', 'initial');
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('checkMerge', () => {
  it('reports a clean merge with a tree OID for non-overlapping changes', async () => {
    git('checkout', '-b', 'feature');
    commit('a.txt', 'alpha', 'add a');
    git('checkout', 'main');
    commit('b.txt', 'beta', 'add b');

    const result = await checkMerge(repoDir, 'main', 'feature');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
    expect(result.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.ahead).toBe(1);
  });

  it('reports ahead=0 when the feature branch has nothing new', async () => {
    // Both branches at the same commit → nothing to merge.
    git('checkout', '-b', 'feature');
    const result = await checkMerge(repoDir, 'main', 'feature');
    expect(result.hasConflicts).toBe(false);
    expect(result.ahead).toBe(0);
  });

  it('reports ahead=0 when the feature branch has been merged into base already', async () => {
    git('checkout', '-b', 'feature');
    commit('a.txt', 'alpha', 'add a');
    git('checkout', 'main');
    execSync('git merge --no-ff --no-edit feature', { cwd: repoDir, stdio: 'ignore' });

    const result = await checkMerge(repoDir, 'main', 'feature');
    expect(result.ahead).toBe(0);
  });

  it('reports conflicts with the conflicting file list', async () => {
    commit('shared.txt', 'base-line\n', 'add shared');
    git('checkout', '-b', 'feature');
    commit('shared.txt', 'feature-line\n', 'feature change');
    git('checkout', 'main');
    commit('shared.txt', 'main-line\n', 'main change');

    const result = await checkMerge(repoDir, 'main', 'feature');
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictingFiles).toContain('shared.txt');
    expect(result.treeOid).toBeUndefined();
  });

  it('treats a missing branch as a conflict-style failure', async () => {
    const result = await checkMerge(repoDir, 'main', 'does-not-exist');
    expect(result.hasConflicts).toBe(true);
    expect(result.treeOid).toBeUndefined();
  });
});

describe('mergeBranch', () => {
  it('produces a merge commit with two parents and fast-forwards base', async () => {
    git('checkout', '-b', 'feature');
    commit('a.txt', 'alpha', 'add a');
    const featureSha = git('rev-parse', 'feature');

    git('checkout', 'main');
    commit('b.txt', 'beta', 'add b');
    const baseSha = git('rev-parse', 'main');

    const res = await mergeBranch(repoDir, 'main', 'feature', 'Merge feature');
    expect(res.ok).toBe(true);
    expect(res.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);

    const newBaseSha = git('rev-parse', 'main');
    expect(newBaseSha).toBe(res.mergeCommitSha);

    // Merge commit should have both parents.
    const parents = git('log', '--pretty=%P', '-n', '1', 'main').split(/\s+/);
    expect(parents).toContain(baseSha);
    expect(parents).toContain(featureSha);
  });

  it('refuses to merge when there are conflicts', async () => {
    commit('shared.txt', 'base-line\n', 'add shared');
    git('checkout', '-b', 'feature');
    commit('shared.txt', 'feature-line\n', 'feature change');
    git('checkout', 'main');
    commit('shared.txt', 'main-line\n', 'main change');

    const res = await mergeBranch(repoDir, 'main', 'feature', 'Merge feature');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/conflict/i);
    expect(res.error).toContain('shared.txt');
  });

  it('returns an error when the base branch does not exist', async () => {
    git('checkout', '-b', 'feature');
    commit('a.txt', 'alpha', 'add a');

    const res = await mergeBranch(repoDir, 'nonexistent-base', 'feature', 'Merge');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/resolve branches/i);
  });

  it('refuses to merge when nothing is ahead', async () => {
    // Both branches at the same commit — no-op merge.
    git('checkout', '-b', 'feature');

    const res = await mergeBranch(repoDir, 'main', 'feature', 'Merge');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to merge/i);
  });

  it('leaves the working tree untouched (plumbing only)', async () => {
    git('checkout', '-b', 'feature');
    commit('a.txt', 'alpha', 'add a');
    git('checkout', 'main');

    // Dirty the working tree; the merge must not complain or clobber it.
    writeFileSync(join(repoDir, 'dirty.txt'), 'uncommitted');

    const res = await mergeBranch(repoDir, 'main', 'feature', 'Merge');
    expect(res.ok).toBe(true);

    // Dirty file still present.
    const status = git('status', '--porcelain');
    expect(status).toContain('dirty.txt');
  });
});
