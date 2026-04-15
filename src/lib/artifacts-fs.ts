/**
 * Filesystem operations for ticket artifacts (files produced by supervisor
 * runs that live under `<omniConfigDir>/artifacts/<ticketId>/`).
 *
 * Extracted from ProjectManager (Sprint C2b of the 6.3 decomposition).
 * Intentionally no knowledge of ProjectManager state — callers resolve the
 * artifacts root via `getArtifactsDir` / `getOmniConfigDir` and pass it in
 * as `rootDir`.
 */
import fs from 'fs/promises';
import path from 'path';

import { getMimeType, isTextMime } from '@/lib/mime-types';
import type { ArtifactFileContent, ArtifactFileEntry } from '@/shared/types';

/** Max bytes to slurp for a text preview. Beyond this we return null textContent. */
const MAX_TEXT_PREVIEW_BYTES = 512_000;

/**
 * Resolve a caller-supplied relative path against the artifacts root, throwing
 * on any attempt to escape via `..` / absolute paths / symlink traversal.
 */
export function resolveArtifactPath(rootDir: string, relativePath: string): string {
  const fullPath = path.resolve(rootDir, relativePath);
  // Ensure path separator boundary — without it, /tmp/artifacts-evil would
  // pass a startsWith check against /tmp/artifacts.
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (!fullPath.startsWith(normalizedRoot) && fullPath !== rootDir) {
    throw new Error('Path traversal detected');
  }
  return fullPath;
}

/**
 * List entries under `rootDir` (or a subdirectory specified by `dirPath`).
 * Missing directories return [] — callers shouldn't need to check-then-read.
 * Directories sort first, then alphabetical by name.
 */
export async function listArtifactEntries(rootDir: string, dirPath?: string): Promise<ArtifactFileEntry[]> {
  const targetDir = dirPath ? resolveArtifactPath(rootDir, dirPath) : rootDir;

  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const results: ArtifactFileEntry[] = [];

    for (const entry of entries) {
      const relPath = dirPath ? path.join(dirPath, entry.name) : entry.name;
      const fullPath = path.join(targetDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        results.push({
          relativePath: relPath,
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Skip entries we can't stat
      }
    }

    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * Read an artifact file and return a preview. Text files under
 * `MAX_TEXT_PREVIEW_BYTES` get their full content; everything else returns
 * null textContent so the caller can decide whether to stream or download.
 */
export async function readArtifactFile(rootDir: string, relativePath: string): Promise<ArtifactFileContent> {
  const fullPath = resolveArtifactPath(rootDir, relativePath);
  const stat = await fs.stat(fullPath);
  const mimeType = getMimeType(relativePath);

  if (isTextMime(mimeType) && stat.size <= MAX_TEXT_PREVIEW_BYTES) {
    const textContent = await fs.readFile(fullPath, 'utf-8');
    return { relativePath, mimeType, textContent, size: stat.size };
  }

  return { relativePath, mimeType, textContent: null, size: stat.size };
}
