/**
 * Substrate-aware artifact storage. In a container the agent writes a ticket's
 * artifacts inside the workspace (`<workspace>/.omni-artifacts/<ticketId>`) so
 * they ride the workspace's own persistence (snapshot tar / Files share); the
 * `host` profile uses a host config dir. How the launcher / control-plane
 * *reads* them back depends on the substrate — never a host bind mount:
 *
 *   - `HostFsArtifactStore`  — host profile (+ local single-tenant server): the
 *     agent wrote straight to the host dir, read it directly.
 *   - `DockerArtifactStore`  — devbox: read out of the live container via
 *     `docker exec`/`docker cp`.
 *
 * Both return the identical `ArtifactFileEntry` / `ArtifactFileContent` shapes
 * so the renderer is substrate-agnostic. The ACI/cloud substrate (the workspace
 * Azure Files share read out-of-band via the storage SDK, control-plane-side)
 * implements the same interface and is wired separately for the server build.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getArtifactsDir, getContainerArtifactsDir } from '@/lib/artifacts';
import { listArtifactEntries, readArtifactFile, resolveArtifactPath } from '@/lib/artifacts-fs';
import { getMimeType, isTextMime } from '@/lib/mime-types';
import type { ArtifactFileContent, ArtifactFileEntry } from '@/shared/types';

const execFileAsync = promisify(execFile);

/** Mirror of the preview cap in artifacts-fs — text files larger than this read
 *  back with `textContent: null` (preview-only). */
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

export interface ArtifactStore {
  /** List a directory level under the ticket's artifacts root (default: root). */
  list(ticketId: string, dirPath?: string): Promise<ArtifactFileEntry[]>;
  /** Read one artifact file (text preview inline; binaries → textContent null). */
  read(ticketId: string, relativePath: string): Promise<ArtifactFileContent>;
  /** Write bytes to `relativePath` under the ticket's artifacts root. */
  write(ticketId: string, relativePath: string, data: Buffer): Promise<void>;
}

// ─── Host filesystem (host profile / local server) ──────────────────────────

export class HostFsArtifactStore implements ArtifactStore {
  constructor(private readonly configDir: string) {}

  private root(ticketId: string): string {
    return getArtifactsDir(this.configDir, ticketId);
  }

  list(ticketId: string, dirPath?: string): Promise<ArtifactFileEntry[]> {
    return listArtifactEntries(this.root(ticketId), dirPath);
  }

  read(ticketId: string, relativePath: string): Promise<ArtifactFileContent> {
    return readArtifactFile(this.root(ticketId), relativePath);
  }

  async write(ticketId: string, relativePath: string, data: Buffer): Promise<void> {
    const full = resolveArtifactPath(this.root(ticketId), relativePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, data);
  }
}

// ─── Docker (devbox) — read the live container ──────────────────────────────

/**
 * Reads artifacts out of the per-project devbox container via `docker exec`,
 * the same transport `container-files-changed.ts` uses for diffs. The artifacts
 * dir lives inside the workspace (`<workspace>/.omni-artifacts/<ticketId>`), so
 * it rides the snapshot like the sources; reads require the container to be
 * running (offline reads from the persisted snapshot are a future enhancement).
 */
export class DockerArtifactStore implements ArtifactStore {
  constructor(
    private readonly containerId: string,
    private readonly user = '1000'
  ) {}

  private ticketRoot(ticketId: string): string {
    return getContainerArtifactsDir(ticketId);
  }

  private async exec(args: string[]): Promise<{ ok: boolean; stdout: Buffer }> {
    try {
      const { stdout } = await execFileAsync('docker', ['exec', '-u', this.user, this.containerId, ...args], {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, stdout: stdout as Buffer };
    } catch {
      return { ok: false, stdout: Buffer.alloc(0) };
    }
  }

  async list(ticketId: string, dirPath?: string): Promise<ArtifactFileEntry[]> {
    const base = dirPath ? `${this.ticketRoot(ticketId)}/${dirPath}` : this.ticketRoot(ticketId);
    // One directory level; NUL-free tab-delimited rows: type, size, mtime, name.
    const res = await this.exec(['find', base, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%s\\t%T@\\t%P\\n']);
    if (!res.ok) {
      return []; // missing dir / container down → empty, like the host store
    }
    return parseDockerFindOutput(res.stdout.toString('utf-8'), dirPath);
  }

  async read(ticketId: string, relativePath: string): Promise<ArtifactFileContent> {
    const full = `${this.ticketRoot(ticketId)}/${relativePath}`;
    const mimeType = getMimeType(relativePath);
    const statRes = await this.exec(['stat', '-c', '%s', full]);
    const size = statRes.ok ? Number(statRes.stdout.toString('utf-8').trim()) || 0 : 0;
    if (isTextMime(mimeType) && size <= MAX_TEXT_PREVIEW_BYTES) {
      const catRes = await this.exec(['cat', full]);
      if (catRes.ok) {
        return { relativePath, mimeType, textContent: catRes.stdout.toString('utf-8'), size };
      }
    }
    return { relativePath, mimeType, textContent: null, size };
  }

  async write(ticketId: string, relativePath: string, data: Buffer): Promise<void> {
    const full = `${this.ticketRoot(ticketId)}/${relativePath}`;
    const dir = full.slice(0, full.lastIndexOf('/'));
    await this.exec(['mkdir', '-p', dir]);
    // Stage to a host temp file and `docker cp` it in (no stdin plumbing).
    const tmp = await mkdtemp(join(tmpdir(), 'omni-artifact-'));
    const tmpFile = join(tmp, 'f');
    try {
      await writeFile(tmpFile, data);
      await execFileAsync('docker', ['cp', tmpFile, `${this.containerId}:${full}`]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * Parse one directory level from `find … -printf '%y\t%s\t%T@\t%P\n'` into the
 * shared `ArtifactFileEntry[]`, sorted dirs-first then by name (matching the
 * host store). Pure — exported for testing without a container.
 */
export function parseDockerFindOutput(stdout: string, dirPath?: string): ArtifactFileEntry[] {
  const entries: ArtifactFileEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue;
    }
    const [type, size, mtime, name] = line.split('\t');
    if (!name) {
      continue;
    }
    entries.push({
      relativePath: dirPath ? `${dirPath}/${name}` : name,
      name,
      isDirectory: type === 'd',
      size: Number(size) || 0,
      modifiedAt: Math.floor((Number(mtime) || 0) * 1000),
    });
  }
  entries.sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));
  return entries;
}
