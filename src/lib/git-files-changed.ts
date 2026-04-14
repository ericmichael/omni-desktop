/**
 * Pure-ish git diff helper — given a git directory and a merge base, produces
 * a `DiffResponse` describing every changed file plus a unified patch.
 *
 * Extracted from ProjectManager (Sprint C2a of the 6.3 decomposition). The
 * ticket/task/worktree lookup and merge-base resolution stay in
 * ProjectManager (they depend on store state); this module handles the
 * git CLI dance and file I/O for untracked content.
 *
 * Covered by the T8 wave tests in project-manager.test.ts which exercise
 * every code path against a real tmpdir git repo.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import type { DiffResponse, FileDiff } from '@/shared/types';

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
   * The base reference to diff against:
   * - A commit SHA / branch name → diff that..HEAD
   * - The literal string 'HEAD' → show uncommitted work (staged + unstaged + untracked)
   */
  mergeBase: string;
}

/**
 * Run git against `gitDir` and return the changed-files summary.
 * Any error (missing repo, git failure, etc.) produces an empty response.
 */
export async function getGitFilesChanged(input: GitFilesChangedInput): Promise<DiffResponse> {
  const { gitDir, mergeBase } = input;

  try {
    await fs.access(gitDir);
  } catch {
    return EMPTY;
  }

  try {
    // Check whether HEAD exists (repo may have zero commits).
    let hasHead = true;
    try {
      await execFileAsync('git', ['-C', gitDir, 'rev-parse', '--verify', 'HEAD'], { timeout: 5_000 });
    } catch {
      hasHead = false;
    }

    const files: FileDiff[] = [];

    if (!hasHead) {
      // ── No commits yet ──────────────────────────────────────────────
      // Use `git status --porcelain -z` for NUL-delimited output (handles
      // filenames with spaces, quotes, and unicode correctly).
      const { stdout: lsOutput } = await execFileAsync('git', ['-C', gitDir, 'status', '--porcelain', '-z', '-uall'], {
        timeout: 10_000,
      });
      // -z output: entries are NUL-separated. Rename entries produce two
      // fields (old\0new) but renames are impossible with no commits.
      for (const entry of lsOutput.split('\0')) {
        if (!entry || entry.length < 4) {
          continue;
        }
        const xy = entry.slice(0, 2);
        const filePath = entry.slice(3);
        if (!filePath) {
          continue;
        }
        const status: FileDiff['status'] = xy.includes('?') ? 'untracked' : 'added';
        files.push({ path: filePath, status, additions: 0, deletions: 0, isBinary: false });
      }
    } else {
      // ── Commits exist ───────────────────────────────────────────────
      // When mergeBase === 'HEAD' (no upstream), `git diff HEAD HEAD` is
      // empty — useless. Fall back to showing uncommitted work instead.
      const showUncommitted = mergeBase === 'HEAD';

      if (showUncommitted) {
        // Show staged + unstaged + untracked changes relative to HEAD.
        const { stdout: statusOutput } = await execFileAsync(
          'git',
          ['-C', gitDir, 'status', '--porcelain', '-z', '-uall'],
          { timeout: 10_000 }
        );
        const entries = statusOutput.split('\0');
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          if (!entry || entry.length < 4) {
            continue;
          }
          const xy = entry.slice(0, 2);
          const filePath = entry.slice(3);
          if (!filePath) {
            continue;
          }

          let status: FileDiff['status'];
          if (xy.includes('?')) {
            status = 'untracked';
          } else if (xy.startsWith('R') || xy.endsWith('R')) {
            status = 'renamed';
            i++; // skip the next entry (old path in -z format)
          } else if (xy.startsWith('A') || xy.endsWith('A')) {
            status = 'added';
          } else if (xy.startsWith('D') || xy.endsWith('D')) {
            status = 'deleted';
          } else {
            status = 'modified';
          }

          files.push({ path: filePath, status, additions: 0, deletions: 0, isBinary: false });
        }
      } else {
        // Normal path: diff committed changes between mergeBase and HEAD.
        const { stdout: diffOutput } = await execFileAsync(
          'git',
          ['-C', gitDir, 'diff', '--name-status', '-M', '-C', '-z', mergeBase, 'HEAD'],
          { timeout: 10_000 }
        );

        // -z with --name-status: NUL-delimited as STATUS\0path[\0oldpath]
        const parts = diffOutput.split('\0');
        for (let i = 0; i < parts.length; i++) {
          const statusField = parts[i];
          if (!statusField) {
            continue;
          }
          const statusChar = statusField.charAt(0);
          const filePath = parts[++i] ?? '';
          let oldPath: string | undefined;
          if (statusChar === 'R' || statusChar === 'C') {
            oldPath = filePath;
            i++;
            const newPath = parts[i] ?? '';
            files.push({
              path: newPath,
              oldPath,
              status: statusChar === 'R' ? 'renamed' : 'copied',
              additions: 0,
              deletions: 0,
              isBinary: false,
            });
            continue;
          }

          let status: FileDiff['status'];
          switch (statusChar) {
            case 'A':
              status = 'added';
              break;
            case 'M':
              status = 'modified';
              break;
            case 'D':
              status = 'deleted';
              break;
            default:
              status = 'modified';
          }

          files.push({ path: filePath, oldPath, status, additions: 0, deletions: 0, isBinary: false });
        }
      }
    }

    // Determine the base ref for producing patches.
    // - No commits → empty tree
    // - No upstream (mergeBase was 'HEAD') → diff working tree against HEAD
    // - Normal → diff mergeBase..HEAD
    const effectiveBase = !hasHead ? EMPTY_TREE : mergeBase;
    const diffWorktree = hasHead && mergeBase === 'HEAD';

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]!;
      if (fi >= MAX_PATCH_FILES) {
        break;
      }

      try {
        if (file.status === 'untracked') {
          // Untracked files have no git object — synthesize a patch from file content.
          const absPath = path.join(gitDir, file.path);
          // Verify the resolved path is still inside gitDir (prevent traversal).
          const realGitDir = await fs.realpath(gitDir);
          const realFile = await fs.realpath(absPath).catch(() => absPath);
          if (!realFile.startsWith(realGitDir + path.sep) && realFile !== realGitDir) {
            continue;
          }
          const stat = await fs.stat(absPath).catch(() => null);
          if (!stat || !stat.isFile()) {
            continue;
          }
          if (stat.size > MAX_UNTRACKED_BYTES) {
            file.isBinary = true;
            continue;
          }
          try {
            const buf = await fs.readFile(absPath);
            // Detect binary: check for NUL bytes in the first 8KB (same heuristic as git).
            const probe = buf.subarray(0, 8192);
            if (probe.includes(0)) {
              file.isBinary = true;
              continue;
            }
            const fileContent = buf.toString('utf-8');
            const lines = fileContent.split('\n');
            // A trailing newline produces an empty last element — don't count it as an added line.
            if (lines.length > 0 && lines[lines.length - 1] === '') {
              lines.pop();
            }
            file.additions = lines.length;
            totalAdditions += file.additions;
            const patchLines = lines.map((l) => `+${l}`);
            file.patch = `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${patchLines.join('\n')}`;
          } catch {
            file.isBinary = true;
          }
          continue;
        }

        // For committed or staged diffs, use git diff directly.
        // When diffWorktree is true we diff the working tree against HEAD (no second ref).
        const diffArgs = diffWorktree
          ? ['-C', gitDir, 'diff', '--unified=8', '--inter-hunk-context=4', 'HEAD', '--', file.path]
          : ['-C', gitDir, 'diff', '--unified=8', '--inter-hunk-context=4', effectiveBase, 'HEAD', '--', file.path];

        const { stdout: patch } = await execFileAsync('git', diffArgs, { timeout: 5_000 });
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

        // Detect binary
        if (file.patch?.includes('Binary files')) {
          file.isBinary = true;
          file.patch = undefined;
        }

        totalAdditions += file.additions;
        totalDeletions += file.deletions;
      } catch {
        // If we can't get the patch for a file, just skip it
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
 * falls back to 'HEAD' which signals "show uncommitted work".
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
 */
export async function resolveWorktreeMergeBase(gitDir: string, branch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitDir, 'merge-base', branch, 'HEAD'], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return branch;
  }
}
