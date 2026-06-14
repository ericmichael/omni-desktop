/**
 * Container-side PR diff extraction.
 *
 * Mirrors :module:`@/lib/git-files-changed` but runs git inside a
 * running docker container via ``docker exec``. Used for local-git
 * projects that have been seeded via ``LocalGitArchive`` — the
 * authoritative workspace lives in the container's ``/workspace``,
 * not on the host, so host-side git would see nothing.
 *
 * Diff base: ``refs/tags/omni/seed`` — created at session boot by the
 * devbox profile's ``init`` step. Represents the state of /workspace
 * just after seeding completed.
 *
 * Returns the same :type:`DiffResponse` shape the renderer's existing
 * ``TicketPRTab`` already consumes, so no UI changes are needed.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { DiffGroup, DiffResponse, FileDiff } from '@/shared/types';

const execFileAsync = promisify(execFile);

const EMPTY: DiffResponse = {
  totalFiles: 0,
  totalAdditions: 0,
  totalDeletions: 0,
  hasChanges: false,
  files: [],
};

const WORKSPACE_ROOT = '/workspace';
const SEED_REF = 'refs/tags/omni/seed';
const TIMEOUT_MS = 10_000;
const MAX_PATCH_FILES = 200;
// Run as the same uid that owns /workspace/* (set by the devbox profile's
// chown init step). Without this, git refuses with "dubious ownership"
// since the container's default uid is root.
const EXEC_USER = '1000:1000';

/** Resolve a per-source mount path inside the container. */
const mountPath = (mountName: string): string => `${WORKSPACE_ROOT}/${mountName}`;

export interface ContainerFilesChangedInput {
  containerId: string;
  /**
   * Subdirectory of ``/workspace`` to scope all git commands to —
   * corresponds to the ``mountName`` of one source in the project's
   * multi-source layout. e.g. ``"launcher"`` → ``/workspace/launcher``.
   */
  mountName: string;
}

/** Run ``git`` inside one source's mounted subdirectory and return stdout. */
const runContainerGit = async (containerId: string, mountName: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', '-u', EXEC_USER, containerId, 'git', '-C', mountPath(mountName), ...args],
    { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout;
};

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

/** Parse ``git diff --name-status -z`` (NUL-delimited). */
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

const listSeedDiffFiles = async (containerId: string, mountName: string): Promise<FileDiff[]> => {
  // Everything between the seed tag and HEAD (work the agent committed)
  const out = await runContainerGit(containerId, mountName, [
    'diff',
    '--name-status',
    '-M',
    '-C',
    '-z',
    SEED_REF,
    'HEAD',
  ]).catch(() => '');
  return parseNameStatus(out, 'committed');
};

const listStagedFiles = async (containerId: string, mountName: string): Promise<FileDiff[]> => {
  // index vs HEAD — what `git add` has staged but not committed
  const out = await runContainerGit(containerId, mountName, [
    'diff',
    '--name-status',
    '-M',
    '-C',
    '-z',
    '--cached',
  ]).catch(() => '');
  return parseNameStatus(out, 'staged');
};

const listUnstagedFiles = async (containerId: string, mountName: string): Promise<FileDiff[]> => {
  // Working tree vs index — edits not yet `git add`'d
  const out = await runContainerGit(containerId, mountName, ['diff', '--name-status', '-M', '-C', '-z']).catch(
    () => ''
  );
  return parseNameStatus(out, 'unstaged');
};

const listUntrackedFiles = async (containerId: string, mountName: string): Promise<FileDiff[]> => {
  // New files not tracked by git (and not gitignored)
  const out = await runContainerGit(containerId, mountName, ['ls-files', '--others', '--exclude-standard', '-z']).catch(
    () => ''
  );
  const files: FileDiff[] = [];
  for (const filePath of out.split('\0')) {
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

const patchArgsFor = (file: FileDiff): string[] => {
  const common = ['diff', '--unified=8', '--inter-hunk-context=4'];
  switch (file.group) {
    case 'committed':
      return [...common, SEED_REF, 'HEAD', '--', file.path];
    case 'staged':
      return [...common, '--cached', '--', file.path];
    case 'unstaged':
      return [...common, '--', file.path];
    case 'untracked':
      // Caller fills these in via a separate path (read the file content)
      return [...common];
  }
};

const buildUntrackedPatch = async (containerId: string, mountName: string, file: FileDiff): Promise<void> => {
  // For untracked files we want a synthetic "added file" patch. The easiest
  // way: read the file content via ``docker exec cat`` and synthesize a
  // unified patch with a single hunk. Cap reads at a sane size.
  const MAX_BYTES = 512_000;
  let content: string;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['exec', '-u', EXEC_USER, containerId, 'head', '-c', String(MAX_BYTES), `${mountPath(mountName)}/${file.path}`],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES + 1024 }
    );
    content = stdout;
  } catch {
    return;
  }
  // Detect binary content the cheap way — null byte presence
  if (content.includes('\0')) {
    file.isBinary = true;
    return;
  }
  const lines = content.split('\n');
  // Strip trailing empty line if file ended with \n
  const last = lines[lines.length - 1];
  if (last === '') {
    lines.pop();
  }
  const additions = lines.map((l) => `+${l}`).join('\n');
  file.patch =
    `diff --git a/${file.path} b/${file.path}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${file.path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${additions}${additions ? '\n' : ''}`;
  file.additions = lines.length;
};

/**
 * Compute the changed-files summary for an agent's container vs the
 * ``omni/seed`` baseline. Errors collapse to ``EMPTY`` (UI shows
 * "no changes" rather than a crash).
 */
export async function getContainerFilesChanged(input: ContainerFilesChangedInput): Promise<DiffResponse> {
  const { containerId, mountName } = input;
  if (!containerId || !mountName) {
    return EMPTY;
  }

  try {
    // Verify the container is running + the seed ref exists in this
    // source's repo. If either fails we have no baseline to diff
    // against — return empty rather than surface a confusing error.
    try {
      await runContainerGit(containerId, mountName, ['rev-parse', '--verify', SEED_REF]);
    } catch {
      return EMPTY;
    }

    const [committed, staged, unstaged, untracked] = await Promise.all([
      listSeedDiffFiles(containerId, mountName),
      listStagedFiles(containerId, mountName),
      listUnstagedFiles(containerId, mountName),
      listUntrackedFiles(containerId, mountName),
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
          await buildUntrackedPatch(containerId, mountName, file);
          totalAdditions += file.additions;
          continue;
        }

        const patch = await runContainerGit(containerId, mountName, patchArgsFor(file));
        file.patch = patch;

        for (const patchLine of patch.split('\n')) {
          if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
            file.additions++;
          } else if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
            file.deletions++;
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
 * Extract a single combined patch (committed + staged + unstaged +
 * untracked, in that order) that represents *every* change in the
 * container's workspace vs the seed baseline. Used by the merge flow
 * to ``git apply`` onto the host repo.
 *
 * Note: ``git diff`` doesn't include untracked files by default.
 * We compose three diffs and append synthetic patches for untracked
 * paths.
 */
export async function buildContainerSeedPatch(containerId: string, mountName: string): Promise<string> {
  if (!containerId || !mountName) {
    return '';
  }

  // diff: HEAD vs working tree (combined committed + staged + unstaged).
  // Using SEED_REF as the base captures every modification since seeding,
  // regardless of whether the agent committed.
  const wt = await runContainerGit(containerId, mountName, ['diff', '--no-color', '--binary', SEED_REF]).catch(
    () => ''
  );

  // Untracked files: synthesize an "added" patch for each.
  const untracked = await listUntrackedFiles(containerId, mountName);
  const untrackedPatches: string[] = [];
  for (const file of untracked) {
    await buildUntrackedPatch(containerId, mountName, file);
    if (file.patch) {
      untrackedPatches.push(file.patch);
    }
  }

  return [wt, ...untrackedPatches].filter((p) => p).join('\n');
}
