/**
 * Tests for git-files-changed.ts — exercises getGitFilesChanged,
 * resolveWorkspaceMergeBase, and resolveWorktreeMergeBase against real
 * tmpdir git repos.
 *
 * These are integration-ish tests because they shell out to real git, but
 * they're fast (tmpdir + tiny repos) and give us confidence in the NUL-
 * delimited parsing, rename detection, binary handling, and path traversal
 * prevention that make up the complexity of this module.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getGitFilesChanged,
  resolveTicketDiffBase,
  resolveWorkspaceMergeBase,
  resolveWorktreeMergeBase,
} from '@/lib/git-files-changed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repoDir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8' }).trim();
}

function initRepo(): void {
  repoDir = mkdtempSync(join(tmpdir(), 'git-test-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
}

function commitFile(name: string, content: string, message?: string): void {
  const filePath = join(repoDir, name);
  const dir = filePath.substring(0, filePath.lastIndexOf(sep));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
  git('add', name);
  git('commit', '-m', message ?? `add ${name}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getGitFilesChanged', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  // ── Zero-commit repo ────────────────────────────────────────────────────

  describe('repo with no commits', () => {
    it('reports untracked files as untracked', async () => {
      writeFileSync(join(repoDir, 'hello.txt'), 'world');
      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      expect(result.hasChanges).toBe(true);
      expect(result.totalFiles).toBe(1);
      expect(result.files[0]!.status).toBe('untracked');
      expect(result.files[0]!.group).toBe('untracked');
      expect(result.files[0]!.path).toBe('hello.txt');
    });

    it('reports staged files as added in the staged group', async () => {
      writeFileSync(join(repoDir, 'staged.txt'), 'content');
      git('add', 'staged.txt');
      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      expect(result.hasChanges).toBe(true);
      const staged = result.files.find((f) => f.path === 'staged.txt');
      expect(staged).toBeDefined();
      expect(staged!.status).toBe('added');
      expect(staged!.group).toBe('staged');
    });

    it('returns empty for a completely empty repo (no files)', async () => {
      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });
      expect(result.hasChanges).toBe(false);
      expect(result.files).toHaveLength(0);
    });
  });

  // ── Grouping (committed / staged / unstaged / untracked) ───────────────

  describe('group split', () => {
    it('reports each source of change under its own group, including the same path in multiple groups', async () => {
      // Start on main with a committed file.
      commitFile('initial.txt', 'v1');
      const baseSha = git('rev-parse', 'HEAD');

      // Feature branch adds a committed change (base..HEAD).
      git('checkout', '-b', 'feature');
      commitFile('committed.txt', 'landed');

      // Stage a new file (HEAD vs index).
      writeFileSync(join(repoDir, 'staged.txt'), 'ready to commit');
      git('add', 'staged.txt');

      // Modify a tracked file without staging (index vs worktree).
      writeFileSync(join(repoDir, 'initial.txt'), 'v1 modified in worktree');

      // Stage + then modify on top — same path in both staged and unstaged.
      writeFileSync(join(repoDir, 'both.txt'), 'staged body');
      git('add', 'both.txt');
      writeFileSync(join(repoDir, 'both.txt'), 'staged body plus more');

      // An untracked file.
      writeFileSync(join(repoDir, 'new-untracked.txt'), 'fresh');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: baseSha });

      const byGroup = (g: string) => result.files.filter((f) => f.group === g).map((f) => f.path);
      expect(byGroup('committed')).toContain('committed.txt');
      expect(byGroup('staged')).toEqual(expect.arrayContaining(['staged.txt', 'both.txt']));
      expect(byGroup('unstaged')).toEqual(expect.arrayContaining(['initial.txt', 'both.txt']));
      expect(byGroup('untracked')).toContain('new-untracked.txt');
    });

    it('omits the committed group when mergeBase is HEAD', async () => {
      commitFile('initial.txt', 'v1');
      writeFileSync(join(repoDir, 'new-untracked.txt'), 'fresh');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });
      expect(result.files.some((f) => f.group === 'committed')).toBe(false);
      expect(result.files.some((f) => f.group === 'untracked')).toBe(true);
    });
  });

  // ── Non-existent / invalid paths ────────────────────────────────────────

  describe('invalid inputs', () => {
    it('returns empty for a non-existent directory', async () => {
      const result = await getGitFilesChanged({ gitDir: '/tmp/no-such-dir-xyz', mergeBase: 'HEAD' });
      expect(result).toEqual({ totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] });
    });

    it('returns empty for a directory that is not a git repo', async () => {
      const nonGit = mkdtempSync(join(tmpdir(), 'non-git-'));
      try {
        const result = await getGitFilesChanged({ gitDir: nonGit, mergeBase: 'HEAD' });
        expect(result.hasChanges).toBe(false);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });

  // ── Committed changes (mergeBase !== HEAD) ──────────────────────────────

  describe('committed changes', () => {
    it('detects added files between mergeBase and HEAD', async () => {
      commitFile('initial.txt', 'init');
      const base = git('rev-parse', 'HEAD');
      commitFile('new-file.txt', 'new content');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.hasChanges).toBe(true);
      expect(result.totalFiles).toBe(1);
      const f = result.files[0]!;
      expect(f.path).toBe('new-file.txt');
      expect(f.status).toBe('added');
      expect(f.patch).toContain('+new content');
      expect(f.additions).toBeGreaterThan(0);
    });

    it('detects modified files', async () => {
      commitFile('file.txt', 'original');
      const base = git('rev-parse', 'HEAD');
      commitFile('file.txt', 'modified');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalFiles).toBe(1);
      expect(result.files[0]!.status).toBe('modified');
      expect(result.files[0]!.patch).toContain('+modified');
      expect(result.files[0]!.patch).toContain('-original');
    });

    it('detects deleted files', async () => {
      commitFile('doomed.txt', 'bye');
      const base = git('rev-parse', 'HEAD');
      git('rm', 'doomed.txt');
      git('commit', '-m', 'delete doomed.txt');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalFiles).toBe(1);
      expect(result.files[0]!.status).toBe('deleted');
    });

    it('detects renamed files with oldPath', async () => {
      commitFile('old-name.txt', 'content stays the same');
      const base = git('rev-parse', 'HEAD');
      git('mv', 'old-name.txt', 'new-name.txt');
      git('commit', '-m', 'rename');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalFiles).toBe(1);
      const f = result.files[0]!;
      expect(f.status).toBe('renamed');
      expect(f.path).toBe('new-name.txt');
      expect(f.oldPath).toBe('old-name.txt');
    });

    it('counts additions and deletions in patches', async () => {
      commitFile('counts.txt', 'line1\nline2\nline3\n');
      const base = git('rev-parse', 'HEAD');
      commitFile('counts.txt', 'line1\nchanged\nline3\nadded\n');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalAdditions).toBeGreaterThan(0);
      expect(result.totalDeletions).toBeGreaterThan(0);
    });

    it('handles multiple changed files', async () => {
      commitFile('a.txt', 'a');
      const base = git('rev-parse', 'HEAD');
      commitFile('b.txt', 'b');
      commitFile('c.txt', 'c');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalFiles).toBe(2);
      const names = result.files.map((f) => f.path).sort();
      expect(names).toEqual(['b.txt', 'c.txt']);
    });
  });

  // ── Uncommitted changes (mergeBase === 'HEAD') ──────────────────────────

  describe('uncommitted changes (mergeBase=HEAD)', () => {
    it('detects unstaged modifications', async () => {
      commitFile('file.txt', 'original');
      writeFileSync(join(repoDir, 'file.txt'), 'changed');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      expect(result.hasChanges).toBe(true);
      const f = result.files.find((f) => f.path === 'file.txt');
      expect(f).toBeDefined();
      expect(f!.status).toBe('modified');
    });

    it('detects staged additions', async () => {
      commitFile('existing.txt', 'v1');
      writeFileSync(join(repoDir, 'new.txt'), 'new');
      git('add', 'new.txt');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'new.txt');
      expect(f).toBeDefined();
      expect(f!.status).toBe('added');
    });

    it('detects untracked files', async () => {
      commitFile('tracked.txt', 'ok');
      writeFileSync(join(repoDir, 'untracked.txt'), 'new file');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'untracked.txt');
      expect(f).toBeDefined();
      expect(f!.status).toBe('untracked');
    });

    it('detects staged deletions', async () => {
      commitFile('to-delete.txt', 'bye');
      git('rm', 'to-delete.txt');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'to-delete.txt');
      expect(f).toBeDefined();
      expect(f!.status).toBe('deleted');
    });

    it('detects staged renames', async () => {
      commitFile('before.txt', 'content preserved for rename detection');
      git('mv', 'before.txt', 'after.txt');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'after.txt');
      expect(f).toBeDefined();
      expect(f!.status).toBe('renamed');
    });
  });

  // ── Untracked file patch synthesis ──────────────────────────────────────

  describe('untracked file patch synthesis', () => {
    it('synthesizes a patch for small text files', async () => {
      commitFile('keep.txt', 'anchor');
      writeFileSync(join(repoDir, 'new.txt'), 'line1\nline2\n');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'new.txt');
      expect(f).toBeDefined();
      expect(f!.patch).toContain('--- /dev/null');
      expect(f!.patch).toContain('+++ b/new.txt');
      expect(f!.patch).toContain('+line1');
      expect(f!.patch).toContain('+line2');
      expect(f!.additions).toBe(2);
    });

    it('marks binary files as binary (NUL byte detection)', async () => {
      commitFile('anchor.txt', 'anchor');
      writeFileSync(join(repoDir, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'binary.bin');
      expect(f).toBeDefined();
      expect(f!.isBinary).toBe(true);
      expect(f!.patch).toBeUndefined();
    });

    it('marks oversized untracked files as binary', async () => {
      commitFile('anchor.txt', 'anchor');
      // 513KB — exceeds MAX_UNTRACKED_BYTES (512KB)
      writeFileSync(join(repoDir, 'big.txt'), 'x'.repeat(513_000));

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'big.txt');
      expect(f).toBeDefined();
      expect(f!.isBinary).toBe(true);
    });

    it('skips untracked directories gracefully', async () => {
      commitFile('anchor.txt', 'anchor');
      mkdirSync(join(repoDir, 'subdir'));
      writeFileSync(join(repoDir, 'subdir', 'nested.txt'), 'nested');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      // Should include the nested file, not crash on the directory
      const f = result.files.find((f) => f.path.includes('nested.txt'));
      expect(f).toBeDefined();
    });

    it('does not count trailing newline as an extra line', async () => {
      commitFile('anchor.txt', 'anchor');
      writeFileSync(join(repoDir, 'trailing.txt'), 'one\ntwo\n');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      const f = result.files.find((f) => f.path === 'trailing.txt');
      expect(f!.additions).toBe(2);
    });
  });

  // ── Path traversal prevention ───────────────────────────────────────────

  describe('path traversal prevention', () => {
    it('skips untracked symlinks that point outside the repo', async () => {
      commitFile('anchor.txt', 'anchor');
      try {
        execFileSync('ln', ['-s', '/etc/passwd', join(repoDir, 'escape')]);
      } catch {
        // symlinks might not work everywhere — skip gracefully
        return;
      }

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: 'HEAD' });

      // The symlink should be listed but NOT have a patch (traversal blocked or not a regular file)
      const f = result.files.find((f) => f.path === 'escape');
      if (f) {
        // Either it was skipped entirely (no patch) or filtered
        expect(f.patch).toBeUndefined();
      }
    });
  });

  // ── Filenames with special characters ───────────────────────────────────

  describe('filenames with special characters', () => {
    it('handles spaces in filenames', async () => {
      commitFile('file with spaces.txt', 'content');
      const base = git('rev-parse', 'HEAD');
      commitFile('another file.txt', 'more');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.files[0]!.path).toBe('another file.txt');
    });

    it('handles files in subdirectories', async () => {
      commitFile('src/lib/deep.ts', 'export const x = 1;');
      const base = git('rev-parse', 'HEAD');
      commitFile('src/lib/new.ts', 'export const y = 2;');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.files[0]!.path).toBe('src/lib/new.ts');
    });
  });

  // ── MAX_PATCH_FILES cap ─────────────────────────────────────────────────

  describe('patch limit', () => {
    it('still reports all files in totalFiles even when patches are capped', async () => {
      commitFile('anchor.txt', 'base');
      const base = git('rev-parse', 'HEAD');

      // Create 205 files (exceeds MAX_PATCH_FILES=200)
      for (let i = 0; i < 205; i++) {
        writeFileSync(join(repoDir, `file-${i.toString().padStart(3, '0')}.txt`), `content-${i}`);
      }
      git('add', '.');
      git('commit', '-m', 'many files');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      expect(result.totalFiles).toBe(205);
      // Only first 200 should have patches; the rest should have 0 additions
      const withPatches = result.files.filter((f) => f.patch);
      expect(withPatches.length).toBeLessThanOrEqual(200);
    });
  });

  // ── Binary detection for committed files ────────────────────────────────

  describe('committed binary files', () => {
    it('detects large binary files via git "Binary files" marker', async () => {
      commitFile('anchor.txt', 'base');
      const base = git('rev-parse', 'HEAD');
      // Must be large enough for git itself to detect as binary (NUL bytes in content).
      // Small files may slip through git's heuristic and produce garbled text patches.
      const binaryContent = Buffer.alloc(1024);
      binaryContent[0] = 0x89;
      binaryContent[1] = 0x50;
      binaryContent[10] = 0x00; // NUL byte triggers git binary detection
      writeFileSync(join(repoDir, 'large.bin'), binaryContent);
      git('add', 'large.bin');
      git('commit', '-m', 'add binary');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      const f = result.files.find((f) => f.path === 'large.bin');
      expect(f).toBeDefined();
      expect(f!.isBinary).toBe(true);
      expect(f!.patch).toBeUndefined();
    });

    it('does NOT detect small binary files as binary in committed diffs (git limitation)', async () => {
      // Git's binary detection for committed diffs relies on git's own heuristic.
      // Tiny files (< ~8KB) without NUL bytes in the first few bytes may not trigger it.
      // The implementation only applies NUL-byte scanning to untracked files.
      commitFile('anchor.txt', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repoDir, 'tiny.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      git('add', 'tiny.png');
      git('commit', '-m', 'add tiny png');

      const result = await getGitFilesChanged({ gitDir: repoDir, mergeBase: base });

      const f = result.files.find((f) => f.path === 'tiny.png');
      expect(f).toBeDefined();
      // This is a known limitation — small committed binaries get text patches
      expect(f!.isBinary).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceMergeBase
// ---------------------------------------------------------------------------

describe('resolveWorkspaceMergeBase', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it('returns HEAD when there is no upstream', async () => {
    commitFile('file.txt', 'v1');
    const result = await resolveWorkspaceMergeBase(repoDir);
    expect(result).toBe('HEAD');
  });

  it('returns HEAD for a non-git directory', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      const result = await resolveWorkspaceMergeBase(nonGit);
      expect(result).toBe('HEAD');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWorktreeMergeBase
// ---------------------------------------------------------------------------

describe('resolveWorktreeMergeBase', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it('returns the merge-base between branch and HEAD', async () => {
    commitFile('file.txt', 'v1');
    const baseCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    commitFile('feature.txt', 'feature work');

    const result = await resolveWorktreeMergeBase(repoDir, 'main');
    expect(result).toBe(baseCommit);
  });

  it('falls back to branch name when merge-base fails', async () => {
    commitFile('file.txt', 'v1');
    const result = await resolveWorktreeMergeBase(repoDir, 'nonexistent-branch');
    expect(result).toBe('nonexistent-branch');
  });

  it("returns 'HEAD' when the branch points at the same commit as HEAD", async () => {
    // Worktree is on the same branch we're diffing against — merge-base equals HEAD,
    // so a diff would be empty and hide uncommitted work. Callers need the 'HEAD'
    // sentinel to fall back to the working-tree diff path.
    commitFile('file.txt', 'v1');
    const result = await resolveWorktreeMergeBase(repoDir, 'main');
    expect(result).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// resolveTicketDiffBase
// ---------------------------------------------------------------------------

describe('resolveTicketDiffBase', () => {
  beforeEach(() => initRepo());
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it('uses the preferred branch when it exists', async () => {
    commitFile('file.txt', 'v1');
    const baseCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'milestone-x');
    commitFile('milestone.txt', 'milestone work');
    const milestoneCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    commitFile('feature.txt', 'feature work');

    const result = await resolveTicketDiffBase(repoDir, 'milestone-x');
    expect(result).toBe(milestoneCommit);
    expect(result).not.toBe(baseCommit);
  });

  it('falls back to main when the preferred branch does not exist', async () => {
    commitFile('file.txt', 'v1');
    const mainCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    commitFile('feature.txt', 'feature work');

    const result = await resolveTicketDiffBase(repoDir, 'nonexistent');
    expect(result).toBe(mainCommit);
  });

  it('falls back to main when no preferred branch is given (the no-worktree case)', async () => {
    // This is the bug fix: a ticket with a branch but no worktree should
    // still get a real merge-base against trunk, not @{upstream} (which is
    // typically the same branch and produces an empty committed group).
    commitFile('file.txt', 'v1');
    const mainCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feat/foo');
    commitFile('foo.txt', 'foo work');

    const result = await resolveTicketDiffBase(repoDir);
    expect(result).toBe(mainCommit);
  });

  it('falls back to master when main is absent', async () => {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), 'git-test-'));
    git('init', '-b', 'master');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test');

    commitFile('file.txt', 'v1');
    const masterCommit = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'feature');
    commitFile('feature.txt', 'feature work');

    const result = await resolveTicketDiffBase(repoDir);
    expect(result).toBe(masterCommit);
  });

  it("returns 'HEAD' when the trunk equals HEAD (no committed diff to show)", async () => {
    commitFile('file.txt', 'v1');
    const result = await resolveTicketDiffBase(repoDir);
    expect(result).toBe('HEAD');
  });

  it("returns 'HEAD' when no candidate exists and there is no upstream", async () => {
    rmSync(repoDir, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), 'git-test-'));
    git('init', '-b', 'develop');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test');
    commitFile('file.txt', 'v1');

    const result = await resolveTicketDiffBase(repoDir);
    expect(result).toBe('HEAD');
  });
});
