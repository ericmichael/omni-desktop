import { readFileSync } from 'fs';
import { join } from 'path';

import { createBrowserManager } from '@/main/browser-manager';
import { createConsoleManager } from '@/main/console-manager';
import { buildStoreSnapshot, PROJECT_KEYS, rowToProject } from '@/main/db-store-bridge';
import { createExtensionManager } from '@/main/extension-manager';
import { syncMcpConfig } from '@/main/mcp-config-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { PlatformClient } from '@/main/platform-client';
import { createPlatformClient, isEnterpriseBuild, mapSandboxProfiles, PLATFORM_URL } from '@/main/platform-mode';
import { createProcessManager } from '@/main/process-manager';
import { closeProjectDb, getDb, openProjectDb } from '@/main/project-db';
import { createProjectManager } from '@/main/project-manager';
import { ProjectMcpServer } from '@/main/project-mcp-server';
import { getOmniConfigDir } from '@/main/util';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { getDefaultPagesDir, migrateFromJson } from 'omni-projects-db';
import { ServerIpcAdapter } from '@/server/ipc-adapter';
import type { ServerStore } from '@/server/store';
import type { WsHandler } from '@/server/ws-handler';
import {
  registerConfigHandlers,
  registerSkillsHandlers,
  registerUtilHandlers,
} from '@/shared/ipc-handlers';
import type { IpcRendererEvents, Project } from '@/shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
type HandleFn = (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;

/**
 * Wire up global (shared) IPC handlers — store, util, config, project, process, main-process.
 * These are stateless or shared, safe for all clients to use.
 *
 * ProcessManager is global so that containers/processes survive WebSocket
 * reconnections and React re-renders. Each WS session reattaching to the same server
 * gets the existing running container status instead of spawning duplicates.
 */
export const wireGlobalHandlers = (arg: { wsHandler: WsHandler; store: ServerStore }) => {
  const { wsHandler, store } = arg;
  const ipc = new ServerIpcAdapter(wsHandler.handle.bind(wsHandler));

  // Project manager — shared across all clients so machines/sandboxes survive reconnections
  const sendToAll: typeof wsHandler.sendToAll = wsHandler.sendToAll.bind(wsHandler);

  // Open shared SQLite DB for project data (mirrors Electron mode in src/main/index.ts).
  // Both this server and the MCP server read/write the same projects.db via WAL.
  const { repo } = openProjectDb();
  try {
    const migrated = migrateFromJson(repo, getDb(), {
      projects: store.get('projects', []) as import('@/shared/types').Project[],
      tickets: store.get('tickets', []) as import('@/shared/types').Ticket[],
      milestones: store.get('milestones', []) as import('@/shared/types').Milestone[],
      pages: store.get('pages', []) as import('@/shared/types').Page[],
      inboxItems: store.get('inboxItems', []) as import('@/shared/types').InboxItem[],
      tasks: store.get('tasks', []) as import('@/shared/types').Task[],
    });
    if (migrated > 0) {
      console.log(`[ProjectDb] Migrated ${migrated} projects from server-store to SQLite`);
    }
  } catch (err) {
    console.error('[ProjectDb] Failed to migrate from server-store:', err);
  }

  const projectMcp = new ProjectMcpServer(getDb(), repo, getDefaultPagesDir());
  projectMcp.start().catch((err) => {
    console.error('[ProjectMcp] failed to start:', err);
  });

  try {
    syncMcpConfig();
  } catch (err) {
    console.error('[mcp-config] failed to sync:', err);
  }

  /** Merged snapshot — SQLite project data + server-store settings. */
  const getStoreSnapshot = () => buildStoreSnapshot(repo, store);

  // --- Global managers (survive WS reconnections) ---

  const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
    ipc,
    sendToWindow: sendToAll,
  });

  // processManager must be created before createProjectManager so it can be passed in
  const [processManager, cleanupProcessManager] = createProcessManager({
    ipc,
    sendToWindow: sendToAll,
    fetchFn: globalThis.fetch,
    getStoreData: () => ({
      sandboxBackend: store.get('sandboxBackend') ?? 'none',
      sandboxProfiles: store.get('sandboxProfiles') ?? null,
      selectedMachineId: store.get('selectedMachineId') ?? null,
      projects: repo.listProjects().map(rowToProject),
    }),
  });

  const [, cleanupProject] = createProjectManager({
    ipc,
    sendToWindow: sendToAll,
    store: store as any,
    processManager,
    repo,
  });

  const [, cleanupExtensions] = createExtensionManager({
    ipc,
    store: store as any,
    sendToWindow: sendToAll,
  });

  // Background workspace sync — keeps project workspaces synced to Azure Files
  // so cloud sessions can mount the share instantly without tar upload.
  const OMNI_CONFIG_DIR = getOmniConfigDir();
  const syncManager = new WorkspaceSyncManager({
    fetchFn: globalThis.fetch,
    manifestDir: OMNI_CONFIG_DIR,
    onStatusChange: (projectId, status) => {
      wsHandler.sendToAll('workspace-sync:status-changed', projectId, status);
    },
  });
  processManager.workspaceSyncManager = syncManager;

  const [, cleanupBrowser] = createBrowserManager({
    ipc,
    sendToWindow: sendToAll,
    store: store as any,
  });

  // Downloads are an Electron-only feature (Chromium session.will-download).
  // In server mode we register stubs so the renderer's tray UI quietly shows
  // "no downloads" rather than erroring out on first invoke.
  ipc.handle('browser:downloads-list', () => []);
  ipc.handle('browser:downloads-clear', () => 0);
  ipc.handle('browser:downloads-remove', () => {});
  ipc.handle('browser:downloads-open-file', () => '');
  ipc.handle('browser:downloads-show-in-folder', () => {});
  ipc.handle('browser:downloads-watch-partition', () => {});
  ipc.handle('browser:permissions-list', () => []);
  ipc.handle('browser:permissions-decide', () => {});
  ipc.handle('browser:permissions-watch-partition', () => {});

  // Wire platform client for enterprise mode
  const updatePlatformClients = () => {
    const platform = store.get('platform');
    const client = createPlatformClient(platform, globalThis.fetch);
    processManager.platformClient = client;
    syncManager.setPlatformClient(client);
  };
  updatePlatformClients();
  const unsubPlatform = store.onDidAnyChange(() => updatePlatformClients());

  /**
   * Auto-start workspace sync for all projects that have a local workspace dir.
   * Called after sign-in and on startup when already authenticated.
   */
  const autoStartSync = () => {
    if (process.env['OMNI_ENABLE_WORKSPACE_UPLOAD'] !== '1') {
      console.log('[WorkspaceSync] OMNI_ENABLE_WORKSPACE_UPLOAD!=1 — skipping auto-start');
      return;
    }
    const projects = (store.get('projects') ?? []) as Project[];
    const backend = store.get('sandboxBackend') ?? 'none';
    // Only sync when platform (cloud) mode is active
    if (backend !== 'platform') return;

    for (const project of projects) {
      if (project.source?.kind === 'local' && project.source.workspaceDir) {
        syncManager.startSync(project.id, project.source.workspaceDir).catch((e) => {
          console.warn(`[WorkspaceSync] Auto-start failed for ${project.id}:`, (e as Error).message);
        });
      }
    }
  };

  // Workspace sync IPC handlers
  ipc.handle('workspace-sync:start', (_, projectId: string, workspaceDir: string) => {
    return syncManager.startSync(projectId, workspaceDir);
  });
  ipc.handle('workspace-sync:stop', (_, projectId: string) => {
    return syncManager.stopSync(projectId);
  });
  ipc.handle('workspace-sync:get-status', (_, projectId: string) => {
    return syncManager.getStatus(projectId);
  });
  ipc.handle('workspace-sync:get-share-name', (_, projectId: string) => {
    return syncManager.getShareName(projectId);
  });

  // Global status getters
  ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());

  // Store change notifications — broadcast to all clients.
  // SQLite-backed project changes are broadcast by ProjectManager/DbChangeWatcher,
  // so we suppress the raw onDidAnyChange path here and rely on the explicit
  // snapshot broadcasts in the set/set-key handlers below.
  // (No handler — explicit broadcasts only.)

  // Store handlers — snapshot-aware: project keys read from SQLite, writes rejected.
  ipc.handle('store:get-key', (_, key) => {
    const k = key as keyof import('@/shared/types').StoreData;
    if (PROJECT_KEYS.has(k)) return getStoreSnapshot()[k];
    return store.get(k);
  });
  ipc.handle('store:set-key', (_, key, value) => {
    const k = key as keyof import('@/shared/types').StoreData;
    if (PROJECT_KEYS.has(k)) {
      throw new Error(
        `store:set-key for project key "${String(k)}" is not allowed when SQLite is active. Use ProjectManager APIs.`
      );
    }
    store.set(k, value as never);
    wsHandler.sendToAll('store:changed', getStoreSnapshot());
  });
  ipc.handle('store:get', () => getStoreSnapshot());
  ipc.handle('store:set', (_, data) => {
    const conflicts = [...PROJECT_KEYS].filter((k) => k in data);
    if (conflicts.length > 0) {
      throw new Error(
        `store:set with project keys [${conflicts.join(', ')}] is not allowed when SQLite is active.`
      );
    }
    store.store = data;
    wsHandler.sendToAll('store:changed', getStoreSnapshot());
  });
  ipc.handle('store:reset', () => {
    store.clear();
    wsHandler.sendToAll('store:changed', getStoreSnapshot());
  });

  // Main process status (simplified for server)
  const mainStatus = { type: 'idle' as const, timestamp: Date.now() };
  ipc.handle('main-process:get-status', () => mainStatus);
  ipc.handle('main-process:exit', () => {});

  // Read version from package.json at startup
  let launcherVersion = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    launcherVersion = (pkg as { version?: string }).version ?? '0.0.0';
  } catch {
    // fallback
  }

  // Shared IPC handlers (config:*, util:*, skills:*) — identical across Electron and server.
  registerConfigHandlers(ipc, OMNI_CONFIG_DIR);
  registerUtilHandlers(ipc, { fetchFn: globalThis.fetch, launcherVersion });
  registerSkillsHandlers(ipc, OMNI_CONFIG_DIR, store);

  // Desktop-only handlers — stubbed for browser mode
  ipc.handle('util:select-directory', () => null);
  ipc.handle('util:select-file', () => null);
  ipc.handle('util:open-directory', () => '');
  ipc.handle('util:open-external', () => {});

  // Platform handlers

  /** Fetch policy and apply sandbox profiles to the store. */
  const fetchAndApplyPolicy = async (credentials: { accessToken: string; refreshToken: string }) => {
    try {
      const client = new PlatformClient(
        { url: PLATFORM_URL, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
        globalThis.fetch
      );
      client.onTokenRefresh = (newToken) => {
        const current = store.get('platform');
        if (current) {
store.set('platform', { ...current, accessToken: newToken });
}
      };
      const policy = await client.getPolicy('omni_code');
      const profiles = mapSandboxProfiles(policy.sandbox_profiles ?? []);
      store.set('sandboxProfiles', profiles.length > 0 ? profiles : null);
      if (profiles.length > 0) {
        const platformProfile = profiles.find((p) => p.backend === 'platform');
        const selected = platformProfile ?? profiles[0]!;
        store.set('sandboxBackend', selected.backend);
        store.set('selectedMachineId', selected.resource_id);
      }
      console.log(`[Platform] Policy applied: ${profiles.length} sandbox profile(s)`);
      // Start background workspace sync now that platform mode is active
      autoStartSync();
    } catch (e) {
      console.warn('[Platform] Failed to fetch policy:', (e as Error).message);
    }
  };

  ipc.handle('platform:is-enterprise', () => isEnterpriseBuild());
  ipc.handle('platform:get-auth', () => store.get('platform') ?? null);
  ipc.handle('platform:sign-in', async () => {
    if (!isEnterpriseBuild()) {
      throw new Error('Not an enterprise build');
    }
    const deviceCode = await PlatformClient.initiateDeviceCode(PLATFORM_URL, globalThis.fetch);

    // Poll in background
    void (async () => {
      const maxAttempts = Math.floor(deviceCode.expires_in / deviceCode.interval);
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise<void>((r) => setTimeout(r, deviceCode.interval * 1000));
        try {
          const result = await PlatformClient.pollForToken(PLATFORM_URL, deviceCode.device_code, globalThis.fetch);
          if (result.status === 'authenticated' && result.access_token && result.refresh_token) {
            const credentials = {
              accessToken: result.access_token,
              refreshToken: result.refresh_token,
              userEmail: result.user?.email,
              userName: result.user?.name,
              userRole: result.user?.role,
              domains: result.user?.domains,
            };
            store.set('platform', credentials);
            wsHandler.sendToAll('platform:auth-changed', credentials);
            await fetchAndApplyPolicy(credentials);
            return;
          }
          if (result.status === 'expired') {
return;
}
        } catch {
          // keep polling
        }
      }
    })();

    return {
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      message: deviceCode.message,
    };
  });
  ipc.handle('platform:sign-out', () => {
    store.delete('platform');
    store.set('sandboxProfiles', null);
    store.set('selectedMachineId', null);
    store.set('sandboxBackend', 'none');
    wsHandler.sendToAll('platform:auth-changed', null);
  });

  // Refresh policy on startup if already signed in
  const existingCreds = store.get('platform');
  if (existingCreds?.accessToken && isEnterpriseBuild()) {
    void fetchAndApplyPolicy(existingCreds);
  }

  ipc.handle('platform:get-dashboards', async () => {
    const creds = store.get('platform');
    if (!creds?.accessToken || !isEnterpriseBuild()) {
return [];
}

    try {
      const client = new PlatformClient({
        url: PLATFORM_URL,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken ?? '',
      }, globalThis.fetch);

      client.onTokenRefresh = (newToken) => {
        const current = store.get('platform');
        if (current) {
          store.set('platform', { ...current, accessToken: newToken });
        }
      };

      const policy = await client.getPolicy('omni_code');
      return policy.dashboards ?? [];
    } catch (e) {
      console.warn('[Platform] Failed to fetch dashboards:', (e as Error).message);
      return [];
    }
  });

  const cleanupGlobalManagers = async () => {
    unsubPlatform();
    const results = await Promise.allSettled([
      syncManager.dispose(),
      cleanupProject(),
      cleanupOmniInstall(),
      cleanupProcessManager(),
      cleanupExtensions(),
      projectMcp.stop(),
      cleanupBrowser(),
    ]);
    closeProjectDb();
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up global managers:', errors);
    }
  };

  return { cleanupGlobalManagers };
};

/**
 * Wire up per-client managers — only truly session-scoped resources (PTY console).
 *
 * ProcessManager and OmniInstallManager are ALL global (created in
 * wireGlobalHandlers) so that containers/processes survive WebSocket reconnections
 * and React re-renders. Per-session handlers would shadow the global ones and get
 * destroyed on WS disconnect, killing running containers.
 *
 * Returns a cleanup function for when the client disconnects.
 */
export const wireClientManagers = (arg: {
  handle: HandleFn;
  sendToWindow: SendToWindow;
  store: ServerStore;
}): (() => Promise<void>) => {
  const { handle, sendToWindow } = arg;
  const ipc = new ServerIpcAdapter(handle);

  // Console (PTY) is truly per-session — each browser tab gets its own terminal
  const [, cleanupConsole] = createConsoleManager({
    ipc,
    sendToWindow,
  });

  // Cleanup function — only per-session resources (console PTY)
  const cleanup = async () => {
    const results = await Promise.allSettled([cleanupConsole()]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up client session processes:', errors);
    }
  };

  return cleanup;
};
