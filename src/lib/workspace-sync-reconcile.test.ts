/**
 * Tests for workspace sync reconciliation — ignore rules, conflict resolution,
 * and change classification.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyChanges,
  type LocalFile,
  type RemoteFile,
  resolveConflict,
  shouldIgnore,
} from '@/lib/workspace-sync-reconcile';

// ---------------------------------------------------------------------------
// shouldIgnore
// ---------------------------------------------------------------------------

describe('shouldIgnore', () => {
  it('ignores .git directory', () => {
    expect(shouldIgnore('.git/config')).toBe(true);
  });

  it('ignores node_modules at any depth', () => {
    expect(shouldIgnore('packages/app/node_modules/foo/index.js')).toBe(true);
  });

  it('ignores __pycache__ directory', () => {
    expect(shouldIgnore('src/__pycache__/module.pyc')).toBe(true);
  });

  it('ignores .venv directory', () => {
    expect(shouldIgnore('.venv/bin/python')).toBe(true);
  });

  it('ignores venv directory', () => {
    expect(shouldIgnore('venv/lib/site-packages')).toBe(true);
  });

  it('ignores .env file', () => {
    expect(shouldIgnore('.env')).toBe(true);
  });

  it('ignores .env file in subdirectory', () => {
    expect(shouldIgnore('config/.env')).toBe(true);
  });

  it('does not ignore normal source files', () => {
    expect(shouldIgnore('src/main.ts')).toBe(false);
  });

  it('does not ignore files that merely contain ignore keywords', () => {
    expect(shouldIgnore('docs/node_modules_guide.md')).toBe(false);
  });

  it('does not ignore .env.example', () => {
    expect(shouldIgnore('.env.example')).toBe(false);
  });

  it('works with custom ignore sets', () => {
    const dirs = new Set(['build']);
    const files = new Set(['secrets.json']);
    expect(shouldIgnore('build/output.js', dirs, files)).toBe(true);
    expect(shouldIgnore('config/secrets.json', dirs, files)).toBe(true);
    expect(shouldIgnore('src/index.ts', dirs, files)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe('resolveConflict', () => {
  it('returns push when local is newer', () => {
    expect(resolveConflict(2000, 1000)).toBe('push');
  });

  it('returns pull when remote is newer', () => {
    expect(resolveConflict(1000, 2000)).toBe('pull');
  });

  it('returns none when timestamps are equal', () => {
    expect(resolveConflict(1000, 1000)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// classifyChanges
// ---------------------------------------------------------------------------

describe('classifyChanges', () => {
  it('classifies local-only files as push', () => {
    const local: LocalFile[] = [{ relativePath: 'new.txt', mtime: 1000, size: 100 }];
    const remote: RemoteFile[] = [];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual(['new.txt']);
    expect(result.toPull).toEqual([]);
  });

  it('classifies remote-only files as pull', () => {
    const local: LocalFile[] = [];
    const remote: RemoteFile[] = [{ relativePath: 'remote.txt', lastModified: 1000, size: 100 }];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual([]);
    expect(result.toPull).toEqual(['remote.txt']);
  });

  it('classifies newer local file as push', () => {
    const local: LocalFile[] = [{ relativePath: 'file.txt', mtime: 2000, size: 100 }];
    const remote: RemoteFile[] = [{ relativePath: 'file.txt', lastModified: 1000, size: 100 }];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual(['file.txt']);
    expect(result.toPull).toEqual([]);
  });

  it('classifies newer remote file as pull', () => {
    const local: LocalFile[] = [{ relativePath: 'file.txt', mtime: 1000, size: 100 }];
    const remote: RemoteFile[] = [{ relativePath: 'file.txt', lastModified: 2000, size: 100 }];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual([]);
    expect(result.toPull).toEqual(['file.txt']);
  });

  it('skips files with equal timestamps', () => {
    const local: LocalFile[] = [{ relativePath: 'file.txt', mtime: 1000, size: 100 }];
    const remote: RemoteFile[] = [{ relativePath: 'file.txt', lastModified: 1000, size: 100 }];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual([]);
    expect(result.toPull).toEqual([]);
  });

  it('handles mixed scenario correctly', () => {
    const local: LocalFile[] = [
      { relativePath: 'local-only.txt', mtime: 1000, size: 10 },
      { relativePath: 'shared-newer-local.txt', mtime: 2000, size: 20 },
      { relativePath: 'shared-newer-remote.txt', mtime: 1000, size: 30 },
      { relativePath: 'shared-same.txt', mtime: 1000, size: 40 },
    ];
    const remote: RemoteFile[] = [
      { relativePath: 'remote-only.txt', lastModified: 1000, size: 50 },
      { relativePath: 'shared-newer-local.txt', lastModified: 1000, size: 20 },
      { relativePath: 'shared-newer-remote.txt', lastModified: 2000, size: 30 },
      { relativePath: 'shared-same.txt', lastModified: 1000, size: 40 },
    ];
    const result = classifyChanges(local, remote);
    expect(result.toPush).toEqual(['local-only.txt', 'shared-newer-local.txt']);
    expect(result.toPull).toEqual(['shared-newer-remote.txt', 'remote-only.txt']);
  });

  it('returns empty sets for empty inputs', () => {
    const result = classifyChanges([], []);
    expect(result.toPush).toEqual([]);
    expect(result.toPull).toEqual([]);
  });
});
