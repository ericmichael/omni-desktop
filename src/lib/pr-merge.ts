/**
 * Git plumbing helpers for the local PR flow.
 *
 * `checkMerge` performs a dry-run three-way merge via `git merge-tree
 * --write-tree`. When clean, returns the merged tree OID; when conflicted,
 * returns the list of conflicting paths.
 *
 * `mergeBranch` uses the same plumbing to build a real merge commit and
 * atomically updates the base branch ref — no working-tree churn, so this
 * works even when the user has uncommitted changes in the main repo.
 *
 * Covered by pr-merge.test.ts which exercises every code path against real
 * tmpdir git repos (clean merge, conflicts, CAS failure, missing branches).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MergeCheckResult {
  hasConflicts: boolean;
  conflictingFiles: string[];
  /** OID of the merged tree when the merge is clean. */
  treeOid?: string;
  /** Commits on `feature` that are not on `base`. Zero means nothing to merge. */
  ahead: number;
}

export interface MergeActionResult {
  ok: boolean;
  error?: string;
  /** SHA of the merge commit written to the base branch when ok. */
  mergeCommitSha?: string;
}

const parseConflictingFiles = (stdout: string): string[] => {
  // git merge-tree --write-tree output on conflict:
  //   <tree OID>
  //   <mode> <oid> <stage>\t<path>    (one line per conflicted entry)
  //   ...
  //   (blank line, then informational messages)
  const files = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\d+ [0-9a-f]+ [123]\t(.+)$/);
    if (m && m[1]) {
      files.add(m[1]);
    }
  }
  return Array.from(files).sort();
};

/**
 * Count commits on `feature` that aren't on `base`. Zero means the feature
 * branch has nothing the base doesn't already have — merging would be a
 * no-op. Returns 0 on any git failure.
 */
const countAhead = async (workspaceDir: string, base: string, feature: string): Promise<number> => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceDir, 'rev-list', '--count', `${base}..${feature}`],
      { encoding: 'utf8', timeout: 10_000 }
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

/**
 * Dry-run a three-way merge of `feature` into `base` in the given repo.
 * Does not modify any refs or the working tree. Returns the merged tree OID
 * when clean, or the conflicting file list when not.
 */
export const checkMerge = async (
  workspaceDir: string,
  base: string,
  feature: string
): Promise<MergeCheckResult> => {
  const ahead = await countAhead(workspaceDir, base, feature);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceDir, 'merge-tree', '--write-tree', base, feature],
      { encoding: 'utf8', timeout: 30_000 }
    );
    const treeOid = stdout.split('\n')[0]?.trim();
    if (!treeOid) {
      return { hasConflicts: true, conflictingFiles: [], ahead };
    }
    return { hasConflicts: false, conflictingFiles: [], treeOid, ahead };
  } catch (err) {
    const e = err as { stdout?: string; code?: number; message?: string };
    const stdout = e.stdout ?? '';
    const conflictingFiles = parseConflictingFiles(stdout);
    return { hasConflicts: true, conflictingFiles, ahead };
  }
};

/**
 * Build a merge commit for `feature` → `base` using plumbing (no checkout),
 * then atomically fast-forward the base branch. Fails cleanly when:
 *   - the merge has conflicts
 *   - the base ref moved since we read it (CAS via update-ref's old-value)
 *   - either input ref can't be resolved
 */
export const mergeBranch = async (
  workspaceDir: string,
  base: string,
  feature: string,
  message: string
): Promise<MergeActionResult> => {
  let baseCommit: string;
  let featureCommit: string;
  try {
    const [baseRes, featureRes] = await Promise.all([
      execFileAsync('git', ['-C', workspaceDir, 'rev-parse', base], { encoding: 'utf8', timeout: 5_000 }),
      execFileAsync('git', ['-C', workspaceDir, 'rev-parse', feature], { encoding: 'utf8', timeout: 5_000 }),
    ]);
    baseCommit = baseRes.stdout.trim();
    featureCommit = featureRes.stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not resolve branches: ${msg}` };
  }

  // Refuse no-op merges — feature has no commits the base doesn't already have.
  const ahead = await countAhead(workspaceDir, base, feature);
  if (ahead === 0) {
    return { ok: false, error: 'Nothing to merge — base already contains all commits from the feature branch.' };
  }

  // Produce the merged tree (or detect conflicts).
  let tree: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceDir, 'merge-tree', '--write-tree', base, feature],
      { encoding: 'utf8', timeout: 30_000 }
    );
    const firstLine = stdout.split('\n')[0]?.trim();
    if (!firstLine) {
      return { ok: false, error: 'merge-tree returned empty output' };
    }
    tree = firstLine;
  } catch (err) {
    const e = err as { stdout?: string };
    const files = parseConflictingFiles(e.stdout ?? '');
    const list = files.length > 0 ? files.join(', ') : 'unknown files';
    return { ok: false, error: `Merge has conflicts: ${list}` };
  }

  // Build the merge commit.
  let newCommit: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceDir, 'commit-tree', tree, '-p', baseCommit, '-p', featureCommit, '-m', message],
      { encoding: 'utf8', timeout: 5_000 }
    );
    newCommit = stdout.trim();
    if (!newCommit) {
      return { ok: false, error: 'commit-tree returned empty output' };
    }
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: e.stderr?.trim() || e.message || 'commit-tree failed' };
  }

  // Atomic fast-forward with CAS on base.
  try {
    await execFileAsync(
      'git',
      ['-C', workspaceDir, 'update-ref', `refs/heads/${base}`, newCommit, baseCommit],
      { encoding: 'utf8', timeout: 5_000 }
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      ok: false,
      error: e.stderr?.trim() || e.message || `Failed to update ${base}; another process may have moved it`,
    };
  }

  return { ok: true, mergeCommitSha: newCommit };
};
