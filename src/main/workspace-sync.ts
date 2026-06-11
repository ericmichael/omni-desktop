/**
 * Workspace file sync for Azure Files shares.
 *
 * Provides both bulk (tar-based) and incremental (per-file) sync operations
 * against Azure Files REST API using SAS URLs.
 */

import { execFile } from 'node:child_process';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';

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
      if (task) {
results[currentIdx] = await task();
}
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

/**
 * Upload a large file from disk to Azure Files without loading it into memory.
 * Reads 4 MiB chunks from the file handle and uploads them as PUT Range calls
 * with up to `concurrency` ranges in flight at once.
 */
export async function uploadRemoteFileFromPath(
  parsed: ParsedSasUrl,
  relativePath: string,
  filePath: string,
  fileSize: number,
  fetchFn: FetchFn,
  onProgress?: (bytesUploaded: number) => void,
  concurrency = 4
): Promise<void> {
  // Ensure parent directory exists
  const parentDir = posix.dirname(relativePath);
  if (parentDir && parentDir !== '.') {
    await createRemoteDir(parsed, parentDir, fetchFn);
  }

  // Create file entry with the full size
  const createUrl = fileUrl(parsed, relativePath);
  const createRes = await fetchFn(createUrl, {
    method: 'PUT',
    headers: {
      'x-ms-version': API_VERSION,
      'x-ms-type': 'file',
      'x-ms-content-length': String(fileSize),
      'Content-Length': '0',
    },
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create file "${relativePath}": ${createRes.status}`);
  }

  if (fileSize === 0) return;

  const totalChunks = Math.ceil(fileSize / RANGE_CHUNK_SIZE);
  let bytesUploaded = 0;
  let chunkIdx = 0;

  const fh = await open(filePath, 'r');
  try {
    const uploadChunk = async (): Promise<void> => {
      while (chunkIdx < totalChunks) {
        const i = chunkIdx++;
        const start = i * RANGE_CHUNK_SIZE;
        const end = Math.min(start + RANGE_CHUNK_SIZE, fileSize) - 1;
        const length = end - start + 1;

        // Each worker allocates its own buffer — no sharing across concurrent reads
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, start);
        const chunk = bytesRead === length ? buf : buf.subarray(0, bytesRead);

        const rangeUrl = fileUrl(parsed, relativePath, 'comp=range');
        const rangeRes = await fetchFn(rangeUrl, {
          method: 'PUT',
          headers: {
            'x-ms-version': API_VERSION,
            'x-ms-range': `bytes=${start}-${start + chunk.byteLength - 1}`,
            'x-ms-write': 'update',
            'Content-Length': String(chunk.byteLength),
          },
          body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as BodyInit,
        });
        if (!rangeRes.ok) {
          throw new Error(`Failed to upload range ${start}-${end} for "${relativePath}": ${rangeRes.status}`);
        }

        bytesUploaded += chunk.byteLength;
        onProgress?.(bytesUploaded);
      }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(concurrency, totalChunks); w++) {
      workers.push(uploadChunk());
    }
    await Promise.all(workers);
  } finally {
    await fh.close();
  }
}

/**
 * Download a large file from Azure Files directly to disk without buffering
 * the entire file in memory. Uses GET Range requests in parallel.
 */
export async function downloadRemoteFileToPath(
  parsed: ParsedSasUrl,
  relativePath: string,
  destPath: string,
  fileSize: number,
  fetchFn: FetchFn,
  onProgress?: (bytesDownloaded: number) => void,
  concurrency = 4
): Promise<void> {
  if (fileSize === 0) {
    await writeFile(destPath, Buffer.alloc(0));
    return;
  }

  const totalChunks = Math.ceil(fileSize / RANGE_CHUNK_SIZE);
  let bytesDownloaded = 0;
  let chunkIdx = 0;

  const fh = await open(destPath, 'w');
  try {
    // Pre-allocate the file to the expected size
    await fh.truncate(fileSize);

    const downloadChunk = async (): Promise<void> => {
      while (chunkIdx < totalChunks) {
        const i = chunkIdx++;
        const start = i * RANGE_CHUNK_SIZE;
        const end = Math.min(start + RANGE_CHUNK_SIZE, fileSize) - 1;

        const url = fileUrl(parsed, relativePath);
        const res = await fetchFn(url, {
          method: 'GET',
          headers: {
            'x-ms-version': API_VERSION,
            'Range': `bytes=${start}-${end}`,
          },
        });
        if (!res.ok && res.status !== 206) {
          throw new Error(`Failed to download range ${start}-${end} for "${relativePath}": ${res.status}`);
        }

        const chunk = Buffer.from(await res.arrayBuffer());
        await fh.write(chunk, 0, chunk.byteLength, start);

        bytesDownloaded += chunk.byteLength;
        onProgress?.(bytesDownloaded);
      }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(concurrency, totalChunks); w++) {
      workers.push(downloadChunk());
    }
    await Promise.all(workers);
  } finally {
    await fh.close();
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
    if (match[1]) {
entries.push({ type: 'directory', name: match[1] });
}
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
        if (IGNORE_DIRS.has(entry.name)) {
continue;
}
        await recurse(relativePath);
      } else {
        if (IGNORE_FILES.has(entry.name) || entry.name === ARCHIVE_NAME) {
continue;
}
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

/**
 * Compress a directory to a tarball with live file-count progress via stderr.
 * Uses --checkpoint to report every 500 files processed.
 */
async function compressWithProgress(
  workspaceDir: string,
  tarPath: string,
  excludes: string[],
  onProgress?: ProgressFn
): Promise<void> {
  const checkpoint = ['--checkpoint=500', '--checkpoint-action=dot'];

  const run = (args: string[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let fileCount = 0;
      const proc = execFile('tar', args, { timeout: 300_000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
      proc.stderr?.on('data', (data: Buffer | string) => {
        // Each dot from --checkpoint-action=dot represents 500 files
        const dots = String(data).replace(/[^.]/g, '').length;
        if (dots > 0) {
          fileCount += dots * 500;
          onProgress?.(`Compressing: ~${fileCount.toLocaleString()} files processed...`);
        }
      });
    });

  try {
    await run(['-I', 'zstd -3', '-cf', tarPath, ...checkpoint, ...excludes, '-C', workspaceDir, '.']);
  } catch {
    // Fallback to gzip if zstd not available
    try { await unlink(tarPath); } catch { /* ignore */ }
    await run(['czf', tarPath, ...checkpoint, ...excludes, '-C', workspaceDir, '.']);
  }
}

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
    await compressWithProgress(workspaceDir, tarPath, TAR_EXCLUDES, onProgress);

    const info = await stat(tarPath);
    const sizeMB = (info.size / (1024 * 1024)).toFixed(1);
    onProgress?.(`Archive: ${sizeMB} MB — uploading...`);

    // Stream from disk in 4 MiB chunks with parallel range uploads.
    // Never loads the full archive into memory — handles arbitrarily large files.
    let lastPct = 0;
    await uploadRemoteFileFromPath(parsed, ARCHIVE_NAME, tarPath, info.size, fetchFn, (bytesUploaded) => {
      const pct = Math.floor((bytesUploaded / info.size) * 100);
      if (pct > lastPct) {
        lastPct = pct;
        onProgress?.(`Uploading: ${pct}% (${(bytesUploaded / (1024 * 1024)).toFixed(0)}/${sizeMB} MB)`);
      }
    });

    onProgress?.(`Upload complete: ${sizeMB} MB`);
  } finally {
    try {
 await unlink(tarPath);
} catch { /* ignore */ }
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
    let archiveSize = 0;
    try {
      const headUrl = fileUrl(parsed, ARCHIVE_NAME);
      const headRes = await fetchFn(headUrl, {
        method: 'HEAD',
        headers: { 'x-ms-version': API_VERSION },
      });
      if (!headRes.ok) {
        onProgress?.('No workspace archive found — skipping download');
        return;
      }
      archiveSize = parseInt(headRes.headers.get('content-length') ?? '0', 10);
    } catch {
      onProgress?.('No workspace archive found — skipping download');
      return;
    }

    const sizeMB = (archiveSize / (1024 * 1024)).toFixed(1);
    onProgress?.(`Downloading workspace archive (${sizeMB} MB)...`);

    // Stream to disk in parallel 4 MiB range GETs — never buffers the whole file.
    let lastPct = 0;
    await downloadRemoteFileToPath(parsed, ARCHIVE_NAME, tarPath, archiveSize, fetchFn, (bytesDownloaded) => {
      const pct = Math.floor((bytesDownloaded / archiveSize) * 100);
      if (pct > lastPct) {
        lastPct = pct;
        onProgress?.(`Downloading: ${pct}% (${(bytesDownloaded / (1024 * 1024)).toFixed(0)}/${sizeMB} MB)`);
      }
    });

    onProgress?.('Extracting workspace...');
    // Try zstd first (matches upload), fall back to gzip
    await execFileAsync('tar', ['-I', 'zstd', '-xf', tarPath, '-C', workspaceDir], {
      timeout: 300_000,
    }).catch(() =>
      execFileAsync('tar', ['xzf', tarPath, '-C', workspaceDir], {
        timeout: 300_000,
      })
    );

    onProgress?.(`Download complete: ${sizeMB} MB`);
  } finally {
    try {
 await unlink(tarPath);
} catch { /* ignore */ }
  }
}
