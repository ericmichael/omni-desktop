/**
 * Pure reconciliation logic for workspace file sync.
 *
 * Extracted from WorkspaceSyncManager so conflict resolution, ignore rules,
 * and change classification can be unit-tested without mocking fetch/fs.
 */

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

const DEFAULT_IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const DEFAULT_IGNORE_FILES = new Set(['.env']);

/**
 * Returns true if the given relative path should be excluded from sync.
 * Checks every path segment against ignore dirs and the filename against
 * ignore files.
 */
export function shouldIgnore(
  relativePath: string,
  ignoreDirs: ReadonlySet<string> = DEFAULT_IGNORE_DIRS,
  ignoreFiles: ReadonlySet<string> = DEFAULT_IGNORE_FILES
): boolean {
  const parts = relativePath.split('/');
  for (const part of parts) {
    if (ignoreDirs.has(part)) {
      return true;
    }
  }
  const filename = parts[parts.length - 1];
  if (filename && ignoreFiles.has(filename)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export type SyncDirection = 'push' | 'pull' | 'none';

/**
 * Last-writer-wins conflict resolution based on mtime comparison.
 */
export function resolveConflict(localMtime: number, remoteMtime: number): SyncDirection {
  if (localMtime > remoteMtime) {
    return 'push';
  }
  if (remoteMtime > localMtime) {
    return 'pull';
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------

export type LocalFile = { relativePath: string; mtime: number; size: number };
export type RemoteFile = { relativePath: string; lastModified: number; size: number };

export type ChangeSet = {
  toPush: string[];
  toPull: string[];
};

/**
 * Classify files into push (local → remote) and pull (remote → local) sets.
 *
 * - Files that exist locally but not remotely → push
 * - Files that exist remotely but not locally → pull
 * - Files that exist in both → last-writer-wins by mtime
 */
export function classifyChanges(localFiles: LocalFile[], remoteFiles: RemoteFile[]): ChangeSet {
  const localMap = new Map(localFiles.map((f) => [f.relativePath, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [f.relativePath, f]));

  const toPush: string[] = [];
  const toPull: string[] = [];

  for (const [path, local] of localMap) {
    const remote = remoteMap.get(path);
    if (!remote) {
      toPush.push(path);
    } else {
      const direction = resolveConflict(local.mtime, remote.lastModified);
      if (direction === 'push') {
        toPush.push(path);
      } else if (direction === 'pull') {
        toPull.push(path);
      }
    }
  }

  for (const [path] of remoteMap) {
    if (!localMap.has(path)) {
      toPull.push(path);
    }
  }

  return { toPush, toPull };
}
