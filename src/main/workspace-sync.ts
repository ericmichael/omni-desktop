/**
 * Workspace file sync for Azure Files shares.
 *
 * Provides both bulk (tar-based) and incremental (per-file) sync operations
 * against Azure Files REST API using SAS URLs.
 */

import { execFile } from 'node:child_process';
import { readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { join, posix, dirname } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch;
export type ProgressFn = (message: string) => void;

export type ParsedSasUrl = {
  baseUrl: string;
  sasParams: string;
};

export type RemoteFileEntry = {
  relativePath: string;
  size: number;
  lastModified: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_VERSION = '2024-11-04';
const ARCHIVE_NAME = '__workspace__.tar.gz';
/** Azure Files PUT Range max is 4 MiB. */
const RANGE_CHUNK_SIZE = 4 * 1024 * 1024;

const TAR_EXCLUDES = [
  '--exclude=.git',
  '--exclude=node_modules',
  '--exclude=__pycache__',
  '--exclude=.venv',
  '--exclude=venv',
  '--exclude=.env',
];

export const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
export const IGNORE_FILES = new Set(['.env']);

// ---------------------------------------------------------------------------
// SAS URL helpers
// ---------------------------------------------------------------------------

export function parseSasUrl(sasUrl: string): ParsedSasUrl {
  const qIdx = sasUrl.indexOf('?');
  if (qIdx === -1) {
    return { baseUrl: sasUrl, sasParams: '' };
  }
  return {
    baseUrl: sasUrl.slice(0, qIdx),
    sasParams: sasUrl.slice(qIdx + 1),
  };
}

/** Strip SAS token from a URL or error message so it doesn't leak into logs. */
export function sanitizeUrl(url: string): string {
  // Match anything after '?sig=' or '?sv=' (SAS query params) and redact it
  return url.replace(/\?(?:sig|sv|se|sp|srt|ss|spr|st)=[^\s'")]+/gi, '?[SAS_REDACTED]');
}

export function fileUrl(parsed: ParsedSasUrl, relativePath: string, extraParams?: string): string {
  const encodedPath = relativePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const path = encodedPath ? `/${encodedPath}` : '';
  const extra = extraParams ? `${extraParams}&${parsed.sasParams}` : parsed.sasParams;
  return `${parsed.baseUrl}${path}?${extra}`;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const currentIdx = idx++;
      const task = tasks[currentIdx];
      if (task) results[currentIdx] = await task();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Azure Files REST operations — single file
// ---------------------------------------------------------------------------

/** Create a directory (and all parents) on the Azure Files share. */
export async function createRemoteDir(
  parsed: ParsedSasUrl,
  dirPath: string,
  fetchFn: FetchFn
): Promise<void> {
  // Create each segment from root down
  const segments = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg;
    const url = fileUrl(parsed, current, 'restype=directory');
    const res = await fetchFn(url, {
      method: 'PUT',
      headers: { 'x-ms-version': API_VERSION },
    });
    // 201 Created or 409 Conflict (already exists) are both fine
    if (!res.ok && res.status !== 409) {
      throw new Error(`Failed to create directory "${current}": ${res.status}`);
    }
  }
}

/** Upload a single file to the Azure Files share. Creates parent dirs. */
export async function uploadRemoteFile(
  parsed: ParsedSasUrl,
  relativePath: string,
  contents: Buffer,
  fetchFn: FetchFn
): Promise<void> {
  // Ensure parent directory exists
  const parentDir = posix.dirname(relativePath);
  if (parentDir && parentDir !== '.') {
    await createRemoteDir(parsed, parentDir, fetchFn);
  }

  const size = contents.byteLength;

  // Create file entry
  const createUrl = fileUrl(parsed, relativePath);
  const createRes = await fetchFn(createUrl, {
    method: 'PUT',
    headers: {
      'x-ms-version': API_VERSION,
      'x-ms-type': 'file',
      'x-ms-content-length': String(size),
      'Content-Length': '0',
    },
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create file "${relativePath}": ${createRes.status}`);
  }

  // Upload content in 4 MiB chunks
  if (size > 0) {
    const totalChunks = Math.ceil(size / RANGE_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * RANGE_CHUNK_SIZE;
      const end = Math.min(start + RANGE_CHUNK_SIZE, size) - 1;
      const chunk = contents.subarray(start, end + 1);

      const rangeUrl = fileUrl(parsed, relativePath, 'comp=range');
      const rangeRes = await fetchFn(rangeUrl, {
        method: 'PUT',
        headers: {
          'x-ms-version': API_VERSION,
          'x-ms-range': `bytes=${start}-${end}`,
          'x-ms-write': 'update',
          'Content-Length': String(chunk.byteLength),
        },
        body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as BodyInit,
      });
      if (!rangeRes.ok) {
        throw new Error(`Failed to upload range for "${relativePath}": ${rangeRes.status}`);
      }
    }
  }
}

/** Download a single file from the Azure Files share. */
export async function downloadRemoteFile(
  parsed: ParsedSasUrl,
  relativePath: string,
  fetchFn: FetchFn
): Promise<Buffer> {
  const url = fileUrl(parsed, relativePath);
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { 'x-ms-version': API_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Failed to download "${relativePath}": ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Delete a single file from the Azure Files share. */
export async function deleteRemoteFile(
  parsed: ParsedSasUrl,
  relativePath: string,
  fetchFn: FetchFn
): Promise<void> {
  const url = fileUrl(parsed, relativePath);
  const res = await fetchFn(url, {
    method: 'DELETE',
    headers: { 'x-ms-version': API_VERSION },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete "${relativePath}": ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Azure Files REST operations — listing
// ---------------------------------------------------------------------------

type RawListEntry = {
  type: 'directory' | 'file';
  name: string;
  size?: number;
  lastModified?: string;
};

function parseListXml(xml: string): RawListEntry[] {
  const entries: RawListEntry[] = [];

  const dirRegex = /<Directory><Name>(.*?)<\/Name><\/Directory>/g;
  let match: RegExpExecArray | null;
  while ((match = dirRegex.exec(xml)) !== null) {
    if (match[1]) entries.push({ type: 'directory', name: match[1] });
  }

  const fileRegex = /<File><Name>(.*?)<\/Name><Properties>(?:.*?<Content-Length>(\d+)<\/Content-Length>)?(?:.*?<Last-Modified>(.*?)<\/Last-Modified>)?.*?<\/Properties><\/File>/gs;
  while ((match = fileRegex.exec(xml)) !== null) {
    if (match[1]) {
      entries.push({
        type: 'file',
        name: match[1],
        size: match[2] ? parseInt(match[2], 10) : 0,
        lastModified: match[3],
      });
    }
  }

  return entries;
}

async function listRemoteDir(
  parsed: ParsedSasUrl,
  dirPath: string,
  fetchFn: FetchFn
): Promise<RawListEntry[]> {
  const url = fileUrl(parsed, dirPath, 'restype=directory&comp=list');
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { 'x-ms-version': API_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Failed to list "${dirPath || '(root)'}": ${res.status}`);
  }
  const xml = await res.text();
  return parseListXml(xml);
}

/** Recursively list all files on the remote share. */
export async function listRemoteFiles(
  parsed: ParsedSasUrl,
  fetchFn: FetchFn
): Promise<RemoteFileEntry[]> {
  const files: RemoteFileEntry[] = [];

  async function recurse(dirPath: string): Promise<void> {
    const entries = await listRemoteDir(parsed, dirPath, fetchFn);
    for (const entry of entries) {
      const relativePath = dirPath ? posix.join(dirPath, entry.name) : entry.name;
      if (entry.type === 'directory') {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await recurse(relativePath);
      } else {
        if (IGNORE_FILES.has(entry.name) || entry.name === ARCHIVE_NAME) continue;
        files.push({
          relativePath,
          size: entry.size ?? 0,
          lastModified: entry.lastModified ? new Date(entry.lastModified).getTime() : 0,
        });
      }
    }
  }

  await recurse('');
  return files;
}

// ---------------------------------------------------------------------------
// Bulk upload (tar-based) — for initial sync
// ---------------------------------------------------------------------------

export async function uploadWorkspace(
  workspaceDir: string,
  sasUrl: string,
  fetchFn: FetchFn,
  onProgress?: ProgressFn
): Promise<void> {
  const parsed = parseSasUrl(sasUrl);
  const tarPath = join(tmpdir(), `workspace-upload-${Date.now()}.tar.gz`);

  try {
    onProgress?.('Compressing workspace...');
    await execFileAsync('tar', ['-I', 'zstd -3', '-cf', tarPath, ...TAR_EXCLUDES, '-C', workspaceDir, '.'], {
      timeout: 120_000,
    }).catch(() =>
      // Fallback to gzip if zstd not available
      execFileAsync('tar', ['czf', tarPath, ...TAR_EXCLUDES, '-C', workspaceDir, '.'], {
        timeout: 120_000,
      })
    );

    const info = await stat(tarPath);
    const sizeMB = (info.size / (1024 * 1024)).toFixed(1);
    onProgress?.(`Archive: ${sizeMB} MB`);

    const contents = await readFile(tarPath);
    await uploadRemoteFile(parsed, ARCHIVE_NAME, contents, fetchFn);

    onProgress?.(`Upload complete: ${sizeMB} MB`);
  } finally {
    try { await unlink(tarPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Bulk download (tar-based) — for final sync
// ---------------------------------------------------------------------------

export async function downloadWorkspace(
  workspaceDir: string,
  sasUrl: string,
  fetchFn: FetchFn,
  onProgress?: ProgressFn
): Promise<void> {
  const parsed = parseSasUrl(sasUrl);
  const tarPath = join(tmpdir(), `workspace-download-${Date.now()}.tar.gz`);

  try {
    onProgress?.('Checking for workspace archive...');
    let hasTar = false;
    try {
      const headUrl = fileUrl(parsed, ARCHIVE_NAME);
      const headRes = await fetchFn(headUrl, {
        method: 'HEAD',
        headers: { 'x-ms-version': API_VERSION },
      });
      hasTar = headRes.ok;
    } catch {
      hasTar = false;
    }

    if (!hasTar) {
      onProgress?.('No workspace archive found — skipping download');
      return;
    }

    onProgress?.('Downloading workspace archive...');
    const contents = await downloadRemoteFile(parsed, ARCHIVE_NAME, fetchFn);
    const sizeMB = (contents.byteLength / (1024 * 1024)).toFixed(1);
    onProgress?.(`Downloaded: ${sizeMB} MB`);

    await writeFile(tarPath, contents);

    onProgress?.('Extracting workspace...');
    await execFileAsync('tar', ['xzf', tarPath, '-C', workspaceDir], {
      timeout: 120_000,
    });

    onProgress?.(`Download complete: ${sizeMB} MB`);
  } finally {
    try { await unlink(tarPath); } catch { /* ignore */ }
  }
}
