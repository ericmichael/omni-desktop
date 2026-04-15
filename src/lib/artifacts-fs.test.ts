/**
 * Tests for artifacts-fs.ts — path traversal prevention, directory listing,
 * and file reading with MIME type detection.
 *
 * Uses real tmpdir filesystem to validate security boundaries and edge cases.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listArtifactEntries, readArtifactFile, resolveArtifactPath } from '@/lib/artifacts-fs';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'artifacts-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveArtifactPath
// ---------------------------------------------------------------------------

describe('resolveArtifactPath', () => {
  it('resolves a simple relative path', () => {
    const result = resolveArtifactPath(rootDir, 'file.txt');
    expect(result).toBe(join(rootDir, 'file.txt'));
  });

  it('resolves nested paths', () => {
    const result = resolveArtifactPath(rootDir, 'sub/dir/file.txt');
    expect(result).toBe(join(rootDir, 'sub', 'dir', 'file.txt'));
  });

  it('throws on .. traversal', () => {
    expect(() => resolveArtifactPath(rootDir, '../escape.txt')).toThrow('Path traversal detected');
  });

  it('throws on deeply nested .. traversal', () => {
    expect(() => resolveArtifactPath(rootDir, 'a/b/../../..')).toThrow('Path traversal detected');
  });

  it('throws on absolute path injection', () => {
    expect(() => resolveArtifactPath(rootDir, '/etc/passwd')).toThrow('Path traversal detected');
  });

  it('allows paths that contain .. but stay within root', () => {
    // e.g. "sub/../file.txt" resolves to rootDir/file.txt — still inside root
    const result = resolveArtifactPath(rootDir, 'sub/../file.txt');
    expect(result).toBe(join(rootDir, 'file.txt'));
  });

  it('rejects sibling directory prefix bypass (e.g. rootDir-evil)', () => {
    // If rootDir is /tmp/abcXYZ, a path that resolves to /tmp/abcXYZ-evil/secret
    // should NOT pass, even though it starts with the rootDir string.
    const siblingPath = rootDir + '-evil';
    mkdirSync(siblingPath, { recursive: true });
    try {
      expect(() => resolveArtifactPath(rootDir, `../${siblingPath.split('/').pop()}/secret.txt`)).toThrow(
        'Path traversal detected'
      );
    } finally {
      rmSync(siblingPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// listArtifactEntries
// ---------------------------------------------------------------------------

describe('listArtifactEntries', () => {
  it('returns empty for non-existent directory', async () => {
    const result = await listArtifactEntries(join(rootDir, 'no-such-dir'));
    expect(result).toEqual([]);
  });

  it('returns empty for an empty directory', async () => {
    const result = await listArtifactEntries(rootDir);
    expect(result).toEqual([]);
  });

  it('lists files with correct metadata', async () => {
    writeFileSync(join(rootDir, 'test.txt'), 'hello');
    const result = await listArtifactEntries(rootDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('test.txt');
    expect(result[0]!.relativePath).toBe('test.txt');
    expect(result[0]!.isDirectory).toBe(false);
    expect(result[0]!.size).toBe(5);
    expect(result[0]!.modifiedAt).toBeGreaterThan(0);
  });

  it('sorts directories before files', async () => {
    writeFileSync(join(rootDir, 'z-file.txt'), 'content');
    mkdirSync(join(rootDir, 'a-dir'));

    const result = await listArtifactEntries(rootDir);

    expect(result[0]!.name).toBe('a-dir');
    expect(result[0]!.isDirectory).toBe(true);
    expect(result[1]!.name).toBe('z-file.txt');
    expect(result[1]!.isDirectory).toBe(false);
  });

  it('sorts alphabetically within files and directories', async () => {
    writeFileSync(join(rootDir, 'c.txt'), '');
    writeFileSync(join(rootDir, 'a.txt'), '');
    writeFileSync(join(rootDir, 'b.txt'), '');

    const result = await listArtifactEntries(rootDir);
    const names = result.map((e) => e.name);
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('lists subdirectory contents when dirPath is given', async () => {
    mkdirSync(join(rootDir, 'sub'));
    writeFileSync(join(rootDir, 'sub', 'nested.txt'), 'nested');

    const result = await listArtifactEntries(rootDir, 'sub');

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('nested.txt');
    expect(result[0]!.relativePath).toBe(join('sub', 'nested.txt'));
  });

  it('throws on path traversal in dirPath', async () => {
    await expect(listArtifactEntries(rootDir, '../')).rejects.toThrow('Path traversal detected');
  });
});

// ---------------------------------------------------------------------------
// readArtifactFile
// ---------------------------------------------------------------------------

describe('readArtifactFile', () => {
  it('reads a text file with content', async () => {
    writeFileSync(join(rootDir, 'readme.md'), '# Hello');
    const result = await readArtifactFile(rootDir, 'readme.md');

    expect(result.relativePath).toBe('readme.md');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.textContent).toBe('# Hello');
    expect(result.size).toBe(7);
  });

  it('reads a .json file as text', async () => {
    writeFileSync(join(rootDir, 'data.json'), '{"key":"value"}');
    const result = await readArtifactFile(rootDir, 'data.json');

    expect(result.mimeType).toBe('application/json');
    expect(result.textContent).toBe('{"key":"value"}');
  });

  it('returns null textContent for binary files', async () => {
    writeFileSync(join(rootDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await readArtifactFile(rootDir, 'image.png');

    expect(result.mimeType).toBe('image/png');
    expect(result.textContent).toBeNull();
  });

  it('returns null textContent for large text files', async () => {
    // 513KB exceeds MAX_TEXT_PREVIEW_BYTES (512KB)
    writeFileSync(join(rootDir, 'huge.txt'), 'x'.repeat(513_000));
    const result = await readArtifactFile(rootDir, 'huge.txt');

    expect(result.mimeType).toBe('text/plain');
    expect(result.textContent).toBeNull();
    expect(result.size).toBe(513_000);
  });

  it('throws on path traversal', async () => {
    await expect(readArtifactFile(rootDir, '../../../etc/passwd')).rejects.toThrow('Path traversal detected');
  });

  it('throws for non-existent file', async () => {
    await expect(readArtifactFile(rootDir, 'nope.txt')).rejects.toThrow();
  });

  it('returns unknown MIME for extensionless files', async () => {
    writeFileSync(join(rootDir, 'Makefile'), 'all: build');
    const result = await readArtifactFile(rootDir, 'Makefile');

    expect(result.mimeType).toBe('application/octet-stream');
    // octet-stream is not text, so textContent should be null
    expect(result.textContent).toBeNull();
  });
});
