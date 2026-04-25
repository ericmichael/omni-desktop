/**
 * Background incremental workspace sync — like OneDrive for project workspaces.
 *
 * Watches a local directory and continuously syncs changes to/from an Azure Files
 * share. The same share is mounted into Azure Container Apps containers, so when
 * the user hits "run" the workspace is already there.
 *
 * Sync model:
 *   1. Initial sync — tar upload if share is empty, otherwise incremental reconcile
 *   2. Local watcher — pushes changed files as they are saved
 *   3. Remote poller — pulls container-side changes every N seconds
 *   4. Conflict resolution — last-writer-wins by mtime
 */

import { mkdir, readdir, readFile, stat, unlink,writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import type { PlatformClient } from '@/main/platform-client';
import { decryptFile,encryptFile } from '@/main/workspace-crypto';
import {
  deleteRemoteFile,
  downloadRemoteFile,
  type FetchFn,
  IGNORE_DIRS,
  IGNORE_FILES,
  listRemoteFiles,
  type ParsedSasUrl,
  parseSasUrl,
  type RemoteFileEntry,
  sanitizeUrl,
  uploadRemoteFile,
} from '@/main/workspace-sync';
import type { WorkspaceSyncState, WorkspaceSyncStatus } from '@/shared/types';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ManifestEntry = {
  localMtime: number;
  remoteMtime: number;
  size: number;
};

type AuditEvent = {
  action: 'workspace_sync.upload' | 'workspace_sync.download' | 'workspace_sync.delete';
  share_name: string;
  file_path: string;
  file_size: number;
  timestamp: number;
};

type SyncSession = {
  projectId: string;
  workspaceDir: string;
  shareName: string;
  sasUrl: string;
  sasExpiresAt: number;
  parsed: ParsedSasUrl;
  state: WorkspaceSyncState;
  manifest: Map<string, ManifestEntry>;
  watcher: FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  pendingChanges: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  filesUploaded: number;
  filesDownloaded: number;
  lastSyncAt: number | null;
  lastError?: string;
  /** Suppress watcher events while pulling remote changes. */
  suppressWatcher: boolean;
  /** Progress tracking for current batch operation. */
  progress: WorkspaceSyncStatus['progress'];
  /** AES-256-GCM key for client-side encryption (null = encryption unavailable). */
  encryptionKey: Buffer | null;
  /** Buffered audit events, flushed periodically to the platform. */
  auditBuffer: AuditEvent[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 1_000;
const POLL_INTERVAL_MS = 30_000;
const SAS_REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh 10 min before expiry
const MAX_CONCURRENCY = 8;
const AUDIT_FLUSH_THRESHOLD = 50; // flush after this many events

// ---------------------------------------------------------------------------
// WorkspaceSyncManager
// ---------------------------------------------------------------------------

export class WorkspaceSyncManager {
  private sessions = new Map<string, SyncSession>();
  /** Reference count per projectId — sync tears down only when it reaches 0. */
  private refCounts = new Map<string, number>();
  /** Tracks which workspace dirs are actively synced, to prevent two projects from syncing the same dir. */
  private activeDirs = new Map<string, string>(); // workspaceDir → projectId
  private platformClient: PlatformClient | null = null;
  private fetchFn: FetchFn;
  private manifestDir: string | null;
  private onStatusChange?: (projectId: string, status: WorkspaceSyncStatus) => void;

  constructor(opts: {
    fetchFn: FetchFn;
    platformClient?: PlatformClient | null;
    /** Directory to persist sync manifests (e.g. omni config dir). If null, manifests are in-memory only. */
    manifestDir?: string;
    onStatusChange?: (projectId: string, status: WorkspaceSyncStatus) => void;
  }) {
    this.fetchFn = opts.fetchFn;
    this.platformClient = opts.platformClient ?? null;
    this.manifestDir = opts.manifestDir ?? null;
    this.onStatusChange = opts.onStatusChange;
  }

  setPlatformClient(client: PlatformClient | null): void {
    this.platformClient = client;
  }

  // --- Public API ---

  async startSync(projectId: string, workspaceDir: string): Promise<void> {
    // Workspace upload is opt-in. Set OMNI_ENABLE_WORKSPACE_UPLOAD=1 to enable
    // background sync (and the one-shot tar upload in agent-process.ts).
    // Default off because initial uploads are slow on large workspaces.
    if (process.env['OMNI_ENABLE_WORKSPACE_UPLOAD'] !== '1') {
      console.log(`[WorkspaceSync] OMNI_ENABLE_WORKSPACE_UPLOAD!=1 — skipping startSync for ${projectId}`);
      return;
    }

    // Bump ref count — if already syncing, just increment and return
    const currentRefs = this.refCounts.get(projectId) ?? 0;
    this.refCounts.set(projectId, currentRefs + 1);

    if (this.sessions.has(projectId)) {
      console.log(`[WorkspaceSync] Ref +1 for project ${projectId} (now ${currentRefs + 1})`);
      return;
    }

    // Guard: reject if another project already syncs this directory
    const existingOwner = this.activeDirs.get(workspaceDir);
    if (existingOwner && existingOwner !== projectId) {
      this.refCounts.set(projectId, 0);
      throw new Error(
        `Workspace directory "${workspaceDir}" is already being synced by project ${existingOwner}`
      );
    }

    if (!this.platformClient) {
      this.refCounts.set(projectId, 0);
      console.warn('[WorkspaceSync] No platform client — cannot start sync');
      return;
    }

    this.activeDirs.set(workspaceDir, projectId);

    const session: SyncSession = {
      projectId,
      workspaceDir,
      shareName: '',
      sasUrl: '',
      sasExpiresAt: 0,
      parsed: { baseUrl: '', sasParams: '' },
      state: 'starting',
      manifest: new Map(),
      watcher: null,
      pollTimer: null,
      pendingChanges: new Set(),
      debounceTimer: null,
      filesUploaded: 0,
      filesDownloaded: 0,
      lastSyncAt: null,
      suppressWatcher: false,
      progress: undefined,
      encryptionKey: null,
      auditBuffer: [],
    };
    this.sessions.set(projectId, session);
    this.emitStatus(session);

    try {
      // Load persisted manifest from previous session (if any)
      await this.loadManifest(session);

      // Fetch per-project encryption key — sync is blocked without it
      session.encryptionKey = await this.platformClient!.getProjectEncryptionKey(projectId);
      console.log(`[WorkspaceSync] Encryption key loaded for project ${projectId}`);

      // Get or create the project's persistent share
      await this.ensureSas(session);

      // Initial sync — if we have a manifest, this is an incremental reconcile
      session.state = 'syncing';
      this.emitStatus(session);
      await this.initialSync(session);

      // Start watching + polling
      session.state = 'watching';
      session.progress = undefined;
      this.emitStatus(session);
      this.startWatcher(session);
      this.startPoller(session);

      console.log(`[WorkspaceSync] Sync active for project ${projectId} → share ${session.shareName}`);
    } catch (e) {
      session.state = 'error';
      session.progress = undefined;
      session.lastError = sanitizeUrl((e as Error).message);
      this.emitStatus(session);
      console.error(`[WorkspaceSync] Failed to start sync for ${projectId}:`, sanitizeUrl((e as Error).message));
    }
  }

  async stopSync(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) {
return;
}

    // Decrement ref count — only tear down when no consumers remain
    const refs = Math.max(0, (this.refCounts.get(projectId) ?? 1) - 1);
    this.refCounts.set(projectId, refs);

    if (refs > 0) {
      console.log(`[WorkspaceSync] Ref -1 for project ${projectId} (still ${refs})`);
      return;
    }

    await this.flushAudit(session);
    await this.saveManifest(session);
    this.teardownSession(session);
    this.activeDirs.delete(session.workspaceDir);
    this.sessions.delete(projectId);
    this.refCounts.delete(projectId);
    this.onStatusChange?.(projectId, this.getStatus(projectId));
    console.log(`[WorkspaceSync] Sync stopped for project ${projectId}`);
  }

  getStatus(projectId: string): WorkspaceSyncStatus {
    const session = this.sessions.get(projectId);
    if (!session) {
      return { state: 'stopped', filesUploaded: 0, filesDownloaded: 0, lastSyncAt: null };
    }
    return {
      state: session.state,
      filesUploaded: session.filesUploaded,
      filesDownloaded: session.filesDownloaded,
      lastSyncAt: session.lastSyncAt,
      error: session.lastError,
      progress: session.progress,
    };
  }

  /** Get the share name for a project (if syncing). Used by AgentProcess to mount the pre-synced share. */
  getShareName(projectId: string): string | null {
    return this.sessions.get(projectId)?.shareName ?? null;
  }

  /** Returns true if the project's share has been synced at least once. */
  isSynced(projectId: string): boolean {
    const session = this.sessions.get(projectId);
    return session?.lastSyncAt != null;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      await this.flushAudit(session);
      await this.saveManifest(session);
      this.teardownSession(session);
    }
    this.sessions.clear();
    this.refCounts.clear();
    this.activeDirs.clear();
  }

  // --- Progress tracking ---

  private startProgress(session: SyncSession, phase: 'uploading' | 'downloading' | 'reconciling', totalFiles: number): void {
    session.progress = {
      phase,
      totalFiles,
      completedFiles: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      startedAt: Date.now(),
    };
    this.emitStatus(session);
  }

  private tickProgress(session: SyncSession, bytes: number): void {
    if (!session.progress) {
return;
}
    session.progress.completedFiles++;
    const elapsed = (Date.now() - session.progress.startedAt) / 1000;
    if (elapsed > 0.5) {
      // Use completed files and total bytes for rate estimation
      // We approximate using average file throughput
      const filesRemaining = session.progress.totalFiles - session.progress.completedFiles;
      const secsPerFile = elapsed / session.progress.completedFiles;
      session.progress.etaSeconds = Math.ceil(filesRemaining * secsPerFile);
      // bytes/sec based on cumulative bytes transferred (approximate from last file)
      if (bytes > 0) {
        // Exponential moving average for bytes/sec
        const instantRate = bytes / Math.max(secsPerFile, 0.01);
        session.progress.bytesPerSecond = session.progress.bytesPerSecond > 0
          ? session.progress.bytesPerSecond * 0.7 + instantRate * 0.3
          : instantRate;
      }
    }
    this.emitStatus(session);
  }

  private clearProgress(session: SyncSession): void {
    session.progress = undefined;
  }

  // --- Encryption helpers ---

  /** Encrypt contents before upload. Throws if no key — never upload plaintext. */
  private encrypt(session: SyncSession, contents: Buffer): Buffer {
    if (!session.encryptionKey) {
throw new Error('Cannot sync without encryption key');
}
    return encryptFile(contents, session.encryptionKey);
  }

  /** Decrypt contents after download. Throws if no key — never write unverified data. */
  private decrypt(session: SyncSession, contents: Buffer): Buffer {
    if (!session.encryptionKey) {
throw new Error('Cannot sync without encryption key');
}
    return decryptFile(contents, session.encryptionKey);
  }

  // --- Audit logging ---

  private recordAudit(
    session: SyncSession,
    action: AuditEvent['action'],
    filePath: string,
    fileSize: number
  ): void {
    session.auditBuffer.push({
      action,
      share_name: session.shareName,
      file_path: filePath,
      file_size: fileSize,
      timestamp: Date.now(),
    });
    if (session.auditBuffer.length >= AUDIT_FLUSH_THRESHOLD) {
      void this.flushAudit(session);
    }
  }

  private async flushAudit(session: SyncSession): Promise<void> {
    if (session.auditBuffer.length === 0 || !this.platformClient) {
return;
}
    const events = session.auditBuffer.splice(0);
    try {
      await this.platformClient.reportWorkspaceAuditEvents(events);
    } catch (e) {
      console.warn(`[WorkspaceSync] Audit flush failed:`, sanitizeUrl((e as Error).message));
      // Put events back for retry on next flush
      session.auditBuffer.unshift(...events);
    }
  }

  // --- Manifest persistence ---

  private manifestPath(projectId: string): string | null {
    if (!this.manifestDir) {
return null;
}
    return join(this.manifestDir, 'sync-manifests', `${projectId}.json`);
  }

  private async loadManifest(session: SyncSession): Promise<void> {
    const path = this.manifestPath(session.projectId);
    if (!path) {
return;
}
    try {
      const raw = await readFile(path, 'utf-8');
      const entries = JSON.parse(raw) as Array<[string, ManifestEntry]>;
      session.manifest = new Map(entries);
      console.log(`[WorkspaceSync] Loaded manifest for ${session.projectId}: ${session.manifest.size} entries`);
    } catch {
      // No manifest yet — will do full reconcile
    }
  }

  private async saveManifest(session: SyncSession): Promise<void> {
    const path = this.manifestPath(session.projectId);
    if (!path) {
return;
}
    try {
      await mkdir(dirname(path), { recursive: true });
      const entries = [...session.manifest.entries()];
      await writeFile(path, JSON.stringify(entries), 'utf-8');
    } catch (e) {
      console.warn(`[WorkspaceSync] Failed to save manifest:`, sanitizeUrl((e as Error).message));
    }
  }

  // --- SAS management ---

  private async ensureSas(session: SyncSession): Promise<void> {
    if (session.sasExpiresAt - Date.now() > SAS_REFRESH_MARGIN_MS) {
return;
}

    if (!this.platformClient) {
throw new Error('Platform client not available');
}

    const result = await this.platformClient.getProjectWorkspace(session.projectId);
    session.shareName = result.shareName;
    session.sasUrl = result.sasUrl;
    session.sasExpiresAt = result.expiresAt;
    session.parsed = parseSasUrl(result.sasUrl);
  }

  // --- Initial sync ---

  private async initialSync(session: SyncSession): Promise<void> {
    // Check if remote share has files already
    const remoteFiles = await listRemoteFiles(session.parsed, this.fetchFn);

    if (remoteFiles.length === 0) {
      // Empty share — push all files individually (encrypted)
      console.log(`[WorkspaceSync] Empty share, performing initial encrypted push...`);
      await this.fullPush(session);
    } else {
      // Share has files — reconcile
      console.log(`[WorkspaceSync] Share has ${remoteFiles.length} files, reconciling...`);
      await this.reconcile(session, remoteFiles);
    }

    session.lastSyncAt = Date.now();
    this.clearProgress(session);
    await this.flushAudit(session);
    await this.saveManifest(session);
  }

  /** Push all local files to remote (for first sync after tar upload). */
  private async fullPush(session: SyncSession): Promise<void> {
    const localFiles = await this.walkLocal(session.workspaceDir);
    this.startProgress(session, 'uploading', localFiles.length);

    const tasks = localFiles.map((entry) => async () => {
      const plaintext = await readFile(entry.absolutePath);
      const contents = this.encrypt(session, plaintext);
      await this.ensureSas(session);
      await uploadRemoteFile(session.parsed, entry.relativePath, contents, this.fetchFn);
      session.manifest.set(entry.relativePath, {
        localMtime: entry.mtime,
        remoteMtime: Date.now(),
        size: plaintext.byteLength,
      });
      session.filesUploaded++;
      this.recordAudit(session, 'workspace_sync.upload', entry.relativePath, plaintext.byteLength);
      this.tickProgress(session, contents.byteLength);
    });

    await runConcurrent(tasks, MAX_CONCURRENCY);
    await this.saveManifest(session);
    console.log(`[WorkspaceSync] Full push complete: ${localFiles.length} files`);
  }

  /** Reconcile local and remote state. Push local changes, pull remote changes. */
  private async reconcile(session: SyncSession, remoteFiles: RemoteFileEntry[]): Promise<void> {
    const localFiles = await this.walkLocal(session.workspaceDir);
    const localMap = new Map(localFiles.map((f) => [f.relativePath, f]));
    const remoteMap = new Map(remoteFiles.map((f) => [f.relativePath, f]));

    const toPush: string[] = [];
    const toPull: string[] = [];

    // Files that exist locally but not remotely → push
    for (const [path, local] of localMap) {
      const remote = remoteMap.get(path);
      if (!remote) {
        toPush.push(path);
      } else if (local.mtime > remote.lastModified) {
        toPush.push(path);
      } else if (remote.lastModified > local.mtime) {
        toPull.push(path);
      }
      // Update manifest
      session.manifest.set(path, {
        localMtime: local.mtime,
        remoteMtime: remote?.lastModified ?? 0,
        size: local.size,
      });
    }

    // Files that exist remotely but not locally → pull
    for (const [path] of remoteMap) {
      if (!localMap.has(path)) {
        toPull.push(path);
      }
    }

    const totalOps = toPush.length + toPull.length;
    if (totalOps > 0) {
      this.startProgress(session, 'reconciling', totalOps);
    }

    if (toPush.length > 0) {
      console.log(`[WorkspaceSync] Pushing ${toPush.length} files...`);
      const pushTasks = toPush.map((path) => async () => {
        const local = localMap.get(path);
        if (!local) {
return;
}
        const plaintext = await readFile(local.absolutePath);
        const contents = this.encrypt(session, plaintext);
        await this.ensureSas(session);
        await uploadRemoteFile(session.parsed, path, contents, this.fetchFn);
        session.filesUploaded++;
        this.recordAudit(session, 'workspace_sync.upload', path, plaintext.byteLength);
        this.tickProgress(session, contents.byteLength);
      });
      await runConcurrent(pushTasks, MAX_CONCURRENCY);
    }

    if (toPull.length > 0) {
      console.log(`[WorkspaceSync] Pulling ${toPull.length} files...`);
      session.suppressWatcher = true;
      const pullTasks = toPull.map((path) => async () => {
        await this.ensureSas(session);
        const encrypted = await downloadRemoteFile(session.parsed, path, this.fetchFn);
        const contents = this.decrypt(session, encrypted);
        const localPath = join(session.workspaceDir, ...path.split('/'));
        await mkdir(dirname(localPath), { recursive: true });
        await writeFile(localPath, contents);
        session.filesDownloaded++;
        this.recordAudit(session, 'workspace_sync.download', path, contents.byteLength);
        this.tickProgress(session, encrypted.byteLength);
      });
      await runConcurrent(pullTasks, MAX_CONCURRENCY);
      session.suppressWatcher = false;
    }

    session.lastSyncAt = Date.now();
    await this.flushAudit(session);
    await this.saveManifest(session);
  }

  // --- File watcher (local → remote) ---

  private startWatcher(session: SyncSession): void {
    try {
      const watcher = chokidar.watch(session.workspaceDir, {
        ignoreInitial: true,
        persistent: true,
        ignored: /(^|[/\\])\../, // ignore hidden files/dirs
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });

      watcher.on('all', (_event, filePath) => {
        if (!filePath || session.suppressWatcher) {
return;
}
        // chokidar gives absolute paths — compute relative path
        const relative = filePath.startsWith(session.workspaceDir)
          ? filePath.slice(session.workspaceDir.length).replace(/^[\\/]/, '').split('\\').join('/')
          : filePath;
        if (this.shouldIgnore(relative)) {
return;
}
        session.pendingChanges.add(relative);
        this.debouncePush(session);
      });

      session.watcher = watcher;
    } catch (e) {
      console.warn(`[WorkspaceSync] Watcher failed:`, sanitizeUrl((e as Error).message));
    }
  }

  private debouncePush(session: SyncSession): void {
    if (session.debounceTimer) {
clearTimeout(session.debounceTimer);
}
    session.debounceTimer = setTimeout(() => {
      void this.pushPending(session);
    }, DEBOUNCE_MS);
  }

  private async pushPending(session: SyncSession): Promise<void> {
    if (session.pendingChanges.size === 0) {
return;
}
    const paths = [...session.pendingChanges];
    session.pendingChanges.clear();

    try {
      await this.ensureSas(session);

      // Only show progress for batches of > 5 files (avoid flicker for single saves)
      if (paths.length > 5) {
        this.startProgress(session, 'uploading', paths.length);
      }

      const tasks = paths.map((relativePath) => async () => {
        const absolutePath = join(session.workspaceDir, ...relativePath.split('/'));
        try {
          const info = await stat(absolutePath);
          if (info.isFile()) {
            const plaintext = await readFile(absolutePath);
            const contents = this.encrypt(session, plaintext);
            await uploadRemoteFile(session.parsed, relativePath, contents, this.fetchFn);
            session.manifest.set(relativePath, {
              localMtime: info.mtimeMs,
              remoteMtime: Date.now(),
              size: plaintext.byteLength,
            });
            session.filesUploaded++;
            this.recordAudit(session, 'workspace_sync.upload', relativePath, plaintext.byteLength);
            this.tickProgress(session, contents.byteLength);
          }
        } catch (e: unknown) {
          // File was deleted
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            await deleteRemoteFile(session.parsed, relativePath, this.fetchFn);
            session.manifest.delete(relativePath);
            this.recordAudit(session, 'workspace_sync.delete', relativePath, 0);
          }
        }
      });

      await runConcurrent(tasks, MAX_CONCURRENCY);
      session.lastSyncAt = Date.now();
      this.clearProgress(session);
      await this.saveManifest(session);
      this.emitStatus(session);
    } catch (e) {
      console.warn(`[WorkspaceSync] Push failed:`, sanitizeUrl((e as Error).message));
    }
  }

  // --- Remote poller (remote → local) ---

  private startPoller(session: SyncSession): void {
    session.pollTimer = setInterval(() => {
      void this.pollRemote(session);
    }, POLL_INTERVAL_MS);
  }

  private async pollRemote(session: SyncSession): Promise<void> {
    try {
      await this.ensureSas(session);
      const remoteFiles = await listRemoteFiles(session.parsed, this.fetchFn);
      const remoteMap = new Map(remoteFiles.map((f) => [f.relativePath, f]));

      const toPull: RemoteFileEntry[] = [];

      for (const [path, remote] of remoteMap) {
        const manifest = session.manifest.get(path);
        if (!manifest) {
          // New file on remote
          toPull.push(remote);
        } else if (remote.lastModified > manifest.remoteMtime) {
          // Remote changed since last sync
          toPull.push(remote);
        }
      }

      // Files deleted remotely
      for (const [path] of session.manifest) {
        if (!remoteMap.has(path)) {
          const localPath = join(session.workspaceDir, ...path.split('/'));
          session.suppressWatcher = true;
          try {
 await unlink(localPath); 
} catch { /* ignore */ }
          session.suppressWatcher = false;
          session.manifest.delete(path);
        }
      }

      if (toPull.length > 0) {
        session.suppressWatcher = true;
        if (toPull.length > 5) {
          this.startProgress(session, 'downloading', toPull.length);
        }
        const tasks = toPull.map((remote) => async () => {
          const encrypted = await downloadRemoteFile(session.parsed, remote.relativePath, this.fetchFn);
          const contents = this.decrypt(session, encrypted);
          const localPath = join(session.workspaceDir, ...remote.relativePath.split('/'));
          await mkdir(dirname(localPath), { recursive: true });
          await writeFile(localPath, contents);
          session.manifest.set(remote.relativePath, {
            localMtime: Date.now(),
            remoteMtime: remote.lastModified,
            size: contents.byteLength,
          });
          session.filesDownloaded++;
          this.recordAudit(session, 'workspace_sync.download', remote.relativePath, contents.byteLength);
          this.tickProgress(session, encrypted.byteLength);
        });
        await runConcurrent(tasks, MAX_CONCURRENCY);
        session.suppressWatcher = false;
        session.lastSyncAt = Date.now();
        this.clearProgress(session);
        await this.flushAudit(session);
        await this.saveManifest(session);
        this.emitStatus(session);
      }
    } catch (e) {
      console.warn(`[WorkspaceSync] Poll failed:`, sanitizeUrl((e as Error).message));
    }
  }

  // --- Helpers ---

  private shouldIgnore(relativePath: string): boolean {
    const parts = relativePath.split('/');
    for (const part of parts) {
      if (IGNORE_DIRS.has(part)) {
return true;
}
    }
    const filename = parts[parts.length - 1];
    if (filename && IGNORE_FILES.has(filename)) {
return true;
}
    return false;
  }

  private async walkLocal(dir: string): Promise<Array<{ relativePath: string; absolutePath: string; mtime: number; size: number }>> {
    const results: Array<{ relativePath: string; absolutePath: string; mtime: number; size: number }> = [];

    const walk = async (currentDir: string, relBase: string): Promise<void> => {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const relPath = relBase ? posix.join(relBase, name) : name;
        const absPath = join(currentDir, name);

        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(name)) {
continue;
}
          await walk(absPath, relPath);
        } else if (entry.isFile()) {
          if (IGNORE_FILES.has(name)) {
continue;
}
          const info = await stat(absPath);
          results.push({ relativePath: relPath, absolutePath: absPath, mtime: info.mtimeMs, size: info.size });
        }
      }
    };

    await walk(dir, '');
    return results;
  }

  private teardownSession(session: SyncSession): void {
    if (session.watcher) {
      void session.watcher.close();
      session.watcher = null;
    }
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }
    session.state = 'stopped';
    session.progress = undefined;
  }

  private emitStatus(session: SyncSession): void {
    this.onStatusChange?.(session.projectId, this.getStatus(session.projectId));
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runConcurrent(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const currentIdx = idx++;
      const task = tasks[currentIdx];
      if (task) {
await task();
}
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}
