/**
 * Pure-ish git diff helper — given a git directory and a merge base, produces
 * a `DiffResponse` describing every changed file plus a unified patch, split
 * into four `group`s:
 *
 *   committed   — diffs between `mergeBase` and `HEAD` (what a PR would land)
 *   staged      — diffs between `HEAD` and the index (`git add`-ed work)
 *   unstaged    — diffs between the index and the working tree
 *   untracked   — files not tracked by git at all
 *
 * A single path can appear in multiple groups when changes span them
 * (e.g. a committed modification with unstaged edits on top).
 *
 * Extracted from ProjectManager (Sprint C2a of the 6.3 decomposition). The
 * ticket/task/worktree lookup and merge-base resolution stay in
 * ProjectManager (they depend on store state); this module handles the
 * git CLI dance and file I/O for untracked content.
 *
 * Covered by the test suite in project-manager.test.ts + git-files-changed.test.ts.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import type { DiffGroup, DiffResponse, FileDiff } from '@/shared/types';

const execFileAsync = promisify(execFile);

// The empty-tree SHA is a well-known constant in git — it represents a tree with no files.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d936927d637e';

// Cap the number of files we produce patches for to avoid excessive I/O on large repos.
const MAX_PATCH_FILES = 200;
// Cap individual file reads for untracked files to avoid loading huge files into memory.
const MAX_UNTRACKED_BYTES = 512_000;

const EMPTY: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };

export interface GitFilesChangedInput {
  gitDir: string;
  /**
   * The base reference to diff against for the `committed` group:
   * - A commit SHA / branch name → committed group = `<base>..HEAD`
   * - The literal string 'HEAD' → omit the committed group
   * (staged/unstaged/untracked groups are always computed)
   */
  mergeBase: string;
}

const charToStatus = (ch: string): FileDiff['status'] => {
  switch (ch) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'modified';
  }
};

/**
 * Parse NUL-delimited `git diff --name-status -z` output into FileDiff rows.
 * Rename/copy entries span three fields: `<status>\0<old>\0<new>`.
 */
const parseNameStatus = (output: string, group: DiffGroup): FileDiff[] => {
  const files: FileDiff[] = [];
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const statusField = parts[i];
    if (!statusField) {
      continue;
    }
    const statusChar = statusField.charAt(0);
    if (statusChar === 'R' || statusChar === 'C') {
      const oldPath = parts[++i] ?? '';
      const newPath = parts[++i] ?? '';
      files.push({
        path: newPath,
        oldPath,
        status: statusChar === 'R' ? 'renamed' : 'copied',
        group,
        additions: 0,
        deletions: 0,
        isBinary: false,
      });
      continue;
    }
    const filePath = parts[++i] ?? '';
    if (!filePath) {
      continue;
    }
    files.push({
      path: filePath,
      status: charToStatus(statusChar),
      group,
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  }
  return files;
};

const listCommittedFiles = async (gitDir: string, base: string): Promise<FileDiff[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', gitDir, 'diff', '--name-status', '-M', '-C', '-z', base, 'HEAD'],
    { timeout: 10_000 }
  );
  return parseNameStatus(stdout, 'committed');
};

const listStagedFiles = async (gitDir: string, hasHead: boolean): Promise<FileDiff[]> => {
  if (hasHead) {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitDir, 'diff', '--name-status', '-M', '-C', '-z', '--cached'],
      { timeout: 10_000 }
    );
    return parseNameStatus(stdout, 'staged');
  }
  // No HEAD: every tracked path in the index is "added" for the first commit.
  // `git ls-files --stage -z` lists index entries, which is what we need.
  const { stdout } = await execFileAsync(
    'git',
    ['-C', gitDir, 'ls-files', '--stage', '-z'],
    { timeout: 10_000 }
  );
  const files: FileDiff[] = [];
  for (const entry of stdout.split('\0')) {
    if (!entry) {
      continue;
    }
    // Format: `<mode> <oid> <stage>\t<path>`
    const tabIdx = entry.indexOf('\t');
    if (tabIdx < 0) {
      continue;
    }
    const filePath = entry.slice(tabIdx + 1);
    if (!filePath) {
      continue;
    }
    files.push({
      path: filePath,
      status: 'added',
      group: 'staged',
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  }
  return files;
};

const listUnstagedFiles = async (gitDir: string): Promise<FileDiff[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', gitDir, 'diff', '--name-status', '-M', '-C', '-z'],
    { timeout: 10_000 }
  );
  return parseNameStatus(stdout, 'unstaged');
};

const listUntrackedFiles = async (gitDir: string): Promise<FileDiff[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', gitDir, 'ls-files', '--others', '--exclude-standard', '-z'],
    { timeout: 10_000 }
  );
  const files: FileDiff[] = [];
  for (const filePath of stdout.split('\0')) {
    if (!filePath) {
      continue;
    }
    files.push({
      path: filePath,
      status: 'untracked',
      group: 'untracked',
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  }
  return files;
};

const buildUntrackedPatch = async (file: FileDiff, gitDir: string): Promise<void> => {
  const absPath = path.join(gitDir, file.path);
  // Prevent path traversal: the resolved file must still live inside gitDir.
  const realGitDir = await fs.realpath(gitDir);
  const realFile = await fs.realpath(absPath).catch(() => absPath);
  if (!realFile.startsWith(realGitDir + path.sep) && realFile !== realGitDir) {
    return;
  }
  const stat = await fs.stat(absPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    file.isBinary = true;
    return;
  }
  try {
    const buf = await fs.readFile(absPath);
    // Detect binary via NUL bytes in the first 8KB (matches git's heuristic).
    const probe = buf.subarray(0, 8192);
    if (probe.includes(0)) {
      file.isBinary = true;
      return;
    }
    const fileContent = buf.toString('utf-8');
    const lines = fileContent.split('\n');
    // A trailing newline produces an empty last element; don't count it.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    file.additions = lines.length;
    const patchLines = lines.map((l) => `+${l}`);
    file.patch = `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${patchLines.join('\n')}`;
  } catch {
    file.isBinary = true;
  }
};

const patchArgsFor = (gitDir: string, file: FileDiff, mergeBase: string, hasHead: boolean): string[] => {
  const common = ['-C', gitDir, 'diff', '--unified=8', '--inter-hunk-context=4'];
  switch (file.group) {
    case 'committed':
      return [...common, mergeBase, 'HEAD', '--', file.path];
    case 'staged':
      // `--cached` without HEAD can error; pass the empty tree explicitly.
      return hasHead
        ? [...common, '--cached', '--', file.path]
        : [...common, '--cached', EMPTY_TREE, '--', file.path];
    case 'unstaged':
      return [...common, '--', file.path];
    case 'untracked':
      // Unreachable — untracked patches are synthesized separately.
      return [...common];
  }
};

/**
 * Run git against `gitDir` and return the changed-files summary across all
 * four groups. Any error (missing repo, git failure, etc.) produces an empty
 * response.
 */
export async function getGitFilesChanged(input: GitFilesChangedInput): Promise<DiffResponse> {
  const { gitDir, mergeBase } = input;

  try {
    await fs.access(gitDir);
  } catch {
    return EMPTY;
  }

  try {
    let hasHead = true;
    try {
      await execFileAsync('git', ['-C', gitDir, 'rev-parse', '--verify', 'HEAD'], { timeout: 5_000 });
    } catch {
      hasHead = false;
    }

    // Gather all groups. Committed is skipped when mergeBase is 'HEAD' (no
    // upstream) or when the repo has no commits yet.
    const includeCommitted = hasHead && mergeBase !== 'HEAD';
    const [committed, staged, unstaged, untracked] = await Promise.all([
      includeCommitted ? listCommittedFiles(gitDir, mergeBase).catch(() => []) : Promise.resolve([]),
      listStagedFiles(gitDir, hasHead).catch(() => []),
      hasHead ? listUnstagedFiles(gitDir).catch(() => []) : Promise.resolve([]),
      listUntrackedFiles(gitDir).catch(() => []),
    ]);

    const files: FileDiff[] = [...committed, ...staged, ...unstaged, ...untracked];

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]!;
      if (fi >= MAX_PATCH_FILES) {
        break;
      }

      try {
        if (file.group === 'untracked') {
          await buildUntrackedPatch(file, gitDir);
          totalAdditions += file.additions;
          continue;
        }

        const { stdout: patch } = await execFileAsync('git', patchArgsFor(gitDir, file, mergeBase, hasHead), { timeout: 5_000 });
        file.patch = patch;

        if (file.patch) {
          for (const patchLine of file.patch.split('\n')) {
            if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
              file.additions++;
            } else if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
              file.deletions++;
            }
          }
        }

        if (file.patch?.includes('Binary files')) {
          file.isBinary = true;
          file.patch = undefined;
        }

        totalAdditions += file.additions;
        totalDeletions += file.deletions;
      } catch {
        // Skip files whose patch we couldn't load.
      }
    }

    return {
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
      hasChanges: files.length > 0,
      files,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Resolve the appropriate mergeBase for a git directory when no worktree-base
 * is known. Prefers the upstream tracking branch → merge-base(upstream, HEAD);
 * falls back to 'HEAD' which signals "no committed group".
 */
export async function resolveWorkspaceMergeBase(gitDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', gitDir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { timeout: 10_000 }
    );
    const upstream = stdout.trim();
    if (upstream && upstream !== '@{upstream}') {
      try {
        const { stdout: mb } = await execFileAsync('git', ['-C', gitDir, 'merge-base', upstream, 'HEAD'], {
          timeout: 10_000,
        });
        return mb.trim();
      } catch {
        return upstream;
      }
    }
    return 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * Resolve the mergeBase for a worktree against its branch. Falls back to the
 * branch name if `git merge-base` fails.
 *
 * When the merge-base equals HEAD (worktree is checked out on the base branch
 * itself, or HEAD hasn't diverged), there's no committed diff to show —
 * return the literal 'HEAD' so getGitFilesChanged omits the committed group
 * and focuses on staged/unstaged/untracked instead.
 */
export async function resolveWorktreeMergeBase(gitDir: string, branch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitDir, 'merge-base', branch, 'HEAD'], { timeout: 10_000 });
    const mergeBase = stdout.trim();
    try {
      const { stdout: headSha } = await execFileAsync('git', ['-C', gitDir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
      if (headSha.trim() === mergeBase) {
        return 'HEAD';
      }
    } catch {
      // If HEAD can't be resolved, fall through to the merge-base.
    }
    return mergeBase;
  } catch {
    return branch;
  }
}

async function refExists(gitDir: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', gitDir, 'rev-parse', '--verify', '--quiet', ref], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the merge base for a ticket's "Files Changed" diff. Tries the
 * caller's preferred branch first (typically the milestone branch the ticket
 * branched from, or the worktree's base), then conventional trunk names,
 * then the workspace's upstream tracking branch as a final fallback. The
 * first candidate that actually exists in the repo is used.
 */
export async function resolveTicketDiffBase(gitDir: string, preferredBranch?: string): Promise<string> {
  const candidates = [preferredBranch, 'main', 'master'].filter((c): c is string => Boolean(c));
  for (const ref of candidates) {
    if (await refExists(gitDir, ref)) {
      return resolveWorktreeMergeBase(gitDir, ref);
    }
  }
  return resolveWorkspaceMergeBase(gitDir);
}
