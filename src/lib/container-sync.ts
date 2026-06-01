/**
 * Sync a source's container changes onto its host working copy.
 *
 * Replaces the older "build one seed patch and ``git apply`` it" approach,
 * which broke on a second sync: the patch was always computed against the
 * fixed ``omni/seed`` baseline, so once the host had advanced it would reject
 * the already-applied hunks. Instead we mirror the *current* container files
 * for the changed-vs-seed set directly onto the host — idempotent by
 * construction (re-running just re-copies the current files), and it works for
 * plain (non-git) host directories too, where ``git apply --3way`` can't.
 *
 * The container is authoritative: changed/added files overwrite the host copy,
 * deleted files are removed from the host. Scope is strictly the changed set
 * (never the whole tree), so unrelated host files are untouched.
 *
 * Copy path: ``docker exec … tar -cf -`` (GNU tar in our image, reads the file
 * list NUL-delimited from stdin) streamed into a host ``tar -xf -``. Deletions
 * use Node ``fs`` so we don't depend on host ``rm``/``tar`` flag portability.
 */
import { execFile, spawn } from 'child_process';
import { rm } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = '/workspace';
const SEED_REF = 'refs/tags/omni/seed';
const TIMEOUT_MS = 30_000;
// Same uid that owns /workspace/* (devbox chown init step). Matches
// EXEC_USER in container-files-changed.ts.
const EXEC_USER = '1000:1000';

const mountPath = (mountName: string): string => `${WORKSPACE_ROOT}/${mountName}`;

/** Files to copy (added/modified) and remove (deleted) on the host. */
export interface ContainerChangeSet {
  copy: string[];
  remove: string[];
}

/** Result of a host sync. */
export interface SyncResult {
  ok: boolean;
  copied: number;
  removed: number;
  error?: string;
}

/**
 * A path is safe to write/delete under the host dir only if it's relative and
 * never escapes via ``..`` or an absolute prefix. Git never emits such paths
 * for tracked/untracked files, but we guard anyway before touching the host.
 */
export function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) {
    return false;
  }
  return p.split('/').every((seg) => seg !== '..');
}

/**
 * Build the copy/remove sets from the three NUL-delimited git listings:
 *   - ``deletions``  — ``git diff --diff-filter=D --name-only --no-renames -z <seed>``
 *   - ``modifies``   — ``git diff --diff-filter=ACMT --name-only --no-renames -z <seed>``
 *   - ``untracked``  — ``git ls-files --others --exclude-standard -z``
 *
 * ``--no-renames`` splits a rename into delete(old) + add(new), which is what
 * we want for mirroring. A path that currently exists (modifies/untracked)
 * always wins over a stale deletion entry. Pure — no I/O.
 */
export function parseChangeSet(deletions: string, modifies: string, untracked: string): ContainerChangeSet {
  const split = (s: string): string[] =>
    s
      .split('\0')
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && isSafeRelPath(p));

  const copy = Array.from(new Set([...split(modifies), ...split(untracked)]));
  const copySet = new Set(copy);
  const remove = Array.from(new Set(split(deletions))).filter((p) => !copySet.has(p));
  return { copy, remove };
}

/** Run ``git`` inside one source's mount and return stdout (throws on failure). */
const runContainerGit = async (containerId: string, mountName: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', '-u', EXEC_USER, containerId, 'git', '-C', mountPath(mountName), ...args],
    { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout;
};

/**
 * Compute the changed-vs-seed file set for a source in a running container.
 * Returns empty sets when the container is down or the seed ref is missing.
 */
export async function getContainerChangeSet(containerId: string, mountName: string): Promise<ContainerChangeSet> {
  if (!containerId || !mountName) {
    return { copy: [], remove: [] };
  }
  try {
    await runContainerGit(containerId, mountName, ['rev-parse', '--verify', SEED_REF]);
  } catch {
    return { copy: [], remove: [] };
  }
  const [deletions, modifies, untracked] = await Promise.all([
    runContainerGit(containerId, mountName, [
      'diff',
      '--diff-filter=D',
      '--name-only',
      '--no-renames',
      '-z',
      SEED_REF,
    ]).catch(() => ''),
    runContainerGit(containerId, mountName, [
      'diff',
      '--diff-filter=ACMT',
      '--name-only',
      '--no-renames',
      '-z',
      SEED_REF,
    ]).catch(() => ''),
    runContainerGit(containerId, mountName, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
  ]);
  return parseChangeSet(deletions, modifies, untracked);
}

/**
 * Stream the given files out of the container and extract them into ``hostDir``,
 * preserving relative paths. GNU tar in the container reads the NUL-delimited
 * list from stdin; the host tar extracts the stream.
 */
function copyFilesToHost(containerId: string, mountName: string, hostDir: string, files: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const producer = spawn(
      'docker',
      ['exec', '-i', '-u', EXEC_USER, containerId, 'tar', '-C', mountPath(mountName), '--null', '-T', '-', '-cf', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const consumer = spawn('tar', ['-C', hostDir, '-xf', '-'], { stdio: ['pipe', 'inherit', 'pipe'] });

    let producerErr = '';
    let consumerErr = '';
    producer.stderr.on('data', (d) => (producerErr += d.toString()));
    consumer.stderr.on('data', (d) => (consumerErr += d.toString()));
    producer.on('error', reject);
    consumer.on('error', reject);

    producer.stdout.pipe(consumer.stdin);

    let pending = 2;
    let failed = false;
    const done = (): void => {
      if (--pending === 0 && !failed) {
        resolve();
      }
    };
    producer.on('close', (code) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`container tar failed (${code}): ${producerErr.trim()}`));
        return;
      }
      done();
    });
    consumer.on('close', (code) => {
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`host tar failed (${code}): ${consumerErr.trim()}`));
        return;
      }
      done();
    });

    producer.stdin.write(files.join('\0'));
    producer.stdin.end();
  });
}

/**
 * Mirror a source's changed-vs-seed files from its container onto ``hostDir``.
 * Idempotent and repeatable. Returns counts; ``ok: false`` with an error on
 * failure. No changes → ``ok: true`` with zero counts.
 */
export async function mirrorContainerChangesToHost(
  containerId: string,
  mountName: string,
  hostDir: string
): Promise<SyncResult> {
  if (!containerId || !mountName || !hostDir) {
    return { ok: false, copied: 0, removed: 0, error: 'Missing container, source, or host directory' };
  }

  const { copy, remove } = await getContainerChangeSet(containerId, mountName);
  if (copy.length === 0 && remove.length === 0) {
    return { ok: true, copied: 0, removed: 0 };
  }

  try {
    if (copy.length > 0) {
      await copyFilesToHost(containerId, mountName, hostDir, copy);
    }
    for (const rel of remove) {
      // Guarded by isSafeRelPath in parseChangeSet; resolve under hostDir.
      await rm(path.join(hostDir, rel), { force: true });
    }
    return { ok: true, copied: copy.length, removed: remove.length };
  } catch (err) {
    return {
      ok: false,
      copied: 0,
      removed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
