/**
 * Workspace file sync for Azure Files shares.
 *
 * Uploads a local directory to an Azure Files share and downloads it back,
 * using the Azure Files REST API with SAS URLs.
 */

import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
type ProgressFn = (message: string) => void;

type ParsedSasUrl = {
  baseUrl: string;
  sasParams: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_VERSION = '2024-11-04';
const MAX_CONCURRENCY = 5;

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const SKIP_FILES = new Set(['.env']);

// ---------------------------------------------------------------------------
// SAS URL helpers
// ---------------------------------------------------------------------------

function parseSasUrl(sasUrl: string): ParsedSasUrl {
  const qIdx = sasUrl.indexOf('?');
  if (qIdx === -1) {
    return { baseUrl: sasUrl, sasParams: '' };
  }
  return {
    baseUrl: sasUrl.slice(0, qIdx),
    sasParams: sasUrl.slice(qIdx + 1),
  };
}

function fileUrl(parsed: ParsedSasUrl, relativePath: string, extraParams?: string): string {
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
// Upload
// ---------------------------------------------------------------------------

type FileEntry = {
  relativePath: string;
  absolutePath: string;
  size: number;
};

async function walkDirectory(dir: string, relativeBase: string): Promise<{ dirs: string[]; files: FileEntry[] }> {
  const dirs: string[] = [];
  const files: FileEntry[] = [];

  async function walk(currentDir: string, currentRelative: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;
      const relativePath = currentRelative ? posix.join(currentRelative, name) : name;
      const absolutePath = join(currentDir, name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        dirs.push(relativePath);
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(name)) continue;
        const info = await stat(absolutePath);
        files.push({ relativePath, absolutePath, size: info.size });
      }
    }
  }

  await walk(dir, relativeBase);
  return { dirs, files };
}

async function createAzureDirectory(
  parsed: ParsedSasUrl,
  relativeDirPath: string,
  fetchFn: FetchFn
): Promise<void> {
  const url = fileUrl(parsed, relativeDirPath, 'restype=directory');
  const res = await fetchFn(url, {
    method: 'PUT',
    headers: { 'x-ms-version': API_VERSION },
  });
  // 201 Created or 409 Conflict (already exists) are both fine
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to create directory "${relativeDirPath}": ${res.status} ${res.statusText}`);
  }
}

async function uploadFile(
  parsed: ParsedSasUrl,
  entry: FileEntry,
  fetchFn: FetchFn
): Promise<void> {
  const contents = await readFile(entry.absolutePath);
  const size = contents.byteLength;

  // Step 1: Create file entry
  const createUrl = fileUrl(parsed, entry.relativePath);
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
    throw new Error(`Failed to create file "${entry.relativePath}": ${createRes.status} ${createRes.statusText}`);
  }

  // Step 2: Upload content (only if file is non-empty)
  if (size > 0) {
    const rangeUrl = fileUrl(parsed, entry.relativePath, 'comp=range');
    const rangeRes = await fetchFn(rangeUrl, {
      method: 'PUT',
      headers: {
        'x-ms-version': API_VERSION,
        'x-ms-range': `bytes=0-${size - 1}`,
        'x-ms-write': 'update',
        'Content-Length': String(size),
      },
      body: contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as BodyInit,
    });
    if (!rangeRes.ok) {
      throw new Error(`Failed to upload file "${entry.relativePath}": ${rangeRes.status} ${rangeRes.statusText}`);
    }
  }
}

export async function uploadWorkspace(
  workspaceDir: string,
  sasUrl: string,
  fetchFn: FetchFn,
  onProgress?: ProgressFn
): Promise<void> {
  const parsed = parseSasUrl(sasUrl);

  onProgress?.('Scanning workspace...');
  const { dirs, files } = await walkDirectory(workspaceDir, '');
  onProgress?.(`Found ${files.length} files in ${dirs.length} directories`);

  // Create directories first (in order so parents exist before children)
  for (const dir of dirs) {
    await createAzureDirectory(parsed, dir, fetchFn);
  }

  // Upload files with concurrency limit
  let completed = 0;
  const total = files.length;

  const tasks = files.map((entry) => async () => {
    await uploadFile(parsed, entry, fetchFn);
    completed++;
    onProgress?.(`Uploading file ${completed}/${total}...`);
  });

  await runWithConcurrency(tasks, MAX_CONCURRENCY);
  onProgress?.(`Upload complete: ${total} files`);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

type ListEntry = {
  type: 'directory' | 'file';
  name: string;
};

function parseListXml(xml: string): ListEntry[] {
  const entries: ListEntry[] = [];

  const dirRegex = /<Directory><Name>(.*?)<\/Name><\/Directory>/g;
  let match: RegExpExecArray | null;
  while ((match = dirRegex.exec(xml)) !== null) {
    if (match[1]) entries.push({ type: 'directory', name: match[1] });
  }

  const fileRegex = /<File><Name>(.*?)<\/Name>/g;
  while ((match = fileRegex.exec(xml)) !== null) {
    if (match[1]) entries.push({ type: 'file', name: match[1] });
  }

  return entries;
}

async function listAzureDirectory(
  parsed: ParsedSasUrl,
  dirPath: string,
  fetchFn: FetchFn
): Promise<ListEntry[]> {
  const extra = dirPath ? 'restype=directory&comp=list' : 'restype=directory&comp=list';
  const url = fileUrl(parsed, dirPath, extra);
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { 'x-ms-version': API_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Failed to list directory "${dirPath || '(root)'}": ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseListXml(xml);
}

type RemoteFile = {
  relativePath: string;
};

async function listAllFiles(
  parsed: ParsedSasUrl,
  fetchFn: FetchFn
): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];

  async function recurse(dirPath: string): Promise<void> {
    const entries = await listAzureDirectory(parsed, dirPath, fetchFn);
    for (const entry of entries) {
      const relativePath = dirPath ? posix.join(dirPath, entry.name) : entry.name;
      if (entry.type === 'directory') {
        await recurse(relativePath);
      } else {
        files.push({ relativePath });
      }
    }
  }

  await recurse('');
  return files;
}

async function downloadFile(
  parsed: ParsedSasUrl,
  remotePath: string,
  localPath: string,
  fetchFn: FetchFn
): Promise<void> {
  const url = fileUrl(parsed, remotePath);
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { 'x-ms-version': API_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Failed to download file "${remotePath}": ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  // Ensure parent directory exists
  const parentDir = join(localPath, '..');
  await mkdir(parentDir, { recursive: true });

  await writeFile(localPath, buffer);
}

export async function downloadWorkspace(
  workspaceDir: string,
  sasUrl: string,
  fetchFn: FetchFn,
  onProgress?: ProgressFn
): Promise<void> {
  const parsed = parseSasUrl(sasUrl);

  onProgress?.('Listing remote workspace files...');
  const remoteFiles = await listAllFiles(parsed, fetchFn);
  onProgress?.(`Found ${remoteFiles.length} files to download`);

  if (remoteFiles.length === 0) {
    onProgress?.('No files to download');
    return;
  }

  // Ensure workspace directory exists
  await mkdir(workspaceDir, { recursive: true });

  let completed = 0;
  const total = remoteFiles.length;

  const tasks = remoteFiles.map((remote) => async () => {
    const localPath = join(workspaceDir, ...remote.relativePath.split('/'));
    await downloadFile(parsed, remote.relativePath, localPath, fetchFn);
    completed++;
    onProgress?.(`Downloading file ${completed}/${total}...`);
  });

  await runWithConcurrency(tasks, MAX_CONCURRENCY);
  onProgress?.(`Download complete: ${total} files`);
}
