if (process.env.NODE_ENV === 'development') {
  require('dotenv/config');
}

import { app, dialog, net, protocol, shell } from 'electron';
import { writeFileSync } from 'fs';
import { migrateFromJson } from 'omni-projects-db';
import { join, resolve } from 'path';
import { assert } from 'tsafe';
import { pathToFileURL } from 'url';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig } from '@/lib/agent-config';
import { getArtifactsDir } from '@/lib/artifacts';
import { createAppControlManager } from '@/main/app-control-manager';
import { listRepos as azureListRepos } from '@/main/azure-repos';
import { createBrowserManager } from '@/main/browser-manager';
import { getStatus as codexStatus, loginWithBrowser, loginWithDeviceFlow, logout as codexLogout } from '@/main/codex-auth';
import { migrateAgentConfigFromFiles } from '@/main/config-files-migration';
import { materializeAgentConfig } from '@/main/config-materializer';
import { createConsoleManager } from '@/main/console-manager';
import { rowToProject } from '@/main/db-store-bridge';
import { createDownloadsManager } from '@/main/downloads-manager';
import { createExtensionManager } from '@/main/extension-manager';
import {
  linkWithDeviceFlow as githubLink,
  listOrgs as githubListOrgs,
  searchRepos as githubSearchRepos,
} from '@/main/github-auth';
import { MainProcessManager } from '@/main/main-process-manager';
import { getMcpBinPath } from '@/main/mcp-config-manager';
import { registerMigrationHandlers } from '@/main/migration-handlers';
import { registerTeamHandlers } from '@/server/team-handlers';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { migrateLegacyPagesToConfigDir } from '@/main/pages-relocation-migration';
import { createPermissionsManager } from '@/main/permissions-manager';
import { registerPlatformIpc } from '@/main/platform-ipc';
import { createPlatformClient } from '@/main/platform-mode';
import { createProcessManager } from '@/main/process-manager';
import { backfillProjectConfigs } from '@/main/project-config-backfill';
import { closeProjectDb, getDb, openProjectDb } from '@/main/project-db';
import { createProjectManager } from '@/main/project-manager';
import { ElectronSecretStore } from '@/main/secret-store';
import { DEFAULT_CHAT_SNAPSHOT_TTL_MS, gcStaleSnapshots, registerSnapshotHandlers } from '@/main/snapshot-manager';
import { getStore } from '@/main/store';
import {
  ensureDirectory,
  getDefaultWorkspaceDir,
  getMcpSandboxHtmlPath,
  getOmniConfigDir,
  getProjectsDir,
  isDirectory,
  isFile,
} from '@/main/util';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { tokenLast4 } from '@/shared/git-credentials';
import {
  registerConfigHandlers,
  registerGitCredentialHandlers,
  registerSettingsConfigHandlers,
  registerSkillsHandlers,
  registerUtilHandlers,
} from '@/shared/ipc-handlers';
import { buildStdioMcpEntry } from '@/shared/mcp-entry';
import type { GitCredential, GithubOwner, GithubRepoQuery, GithubStatus, RemoteRepo } from '@/shared/types';

// Process-level crash visibility. Log only — do not exit. Killing the
// Electron main process from an unhandled rejection would take the whole
// UI down with it, which is worse than letting the rejection slip through.
// The goal here is leaving a stderr breadcrumb so we can debug instead of
// silently losing the failure.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});

// Register artifact: protocol as privileged before app is ready.
// NOTE: `bypassCSP` is intentionally NOT set. Artifacts are agent-generated
// content (Omni Code writes them into ticket workspaces) — bypassing CSP
// would let a malicious or buggy artifact execute scripts with full renderer
// privileges. The `protocol.handle` callback below sets a strict CSP header
// on every artifact response that blocks script execution while still
// allowing images, styles, fonts, and media to render.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artifact',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  // MCP Apps sandbox proxy origin. Registered as a separate, opaque
  // origin so the AppFrame iframe (mcp-ui) is cross-origin isolated from
  // the renderer. ``bypassCSP`` is intentionally not set — the handler
  // sets a strict CSP that lets the proxy script run but blocks anything
  // it loads (apart from the inner iframe written via document.write).
  {
    scheme: 'mcp-sandbox',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

// Configure Chrome/Electron flags for better memory management

// Windows-specific, disables some fancy desktop window effects that can use a lot of memory
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Prevent memory spikes from throttling when the app is in the background and moves to foreground
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Keep renderer active when minimized to avoid memory spikes when restoring
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Remove limits on number of backing stores, which are per-window/tab. Theoretically, the launcher should only have two
// windows open at a time so this should have no effect. But just in case, we disable the limit.
app.commandLine.appendSwitch('disable-backing-store-limit');

// Expose a Chrome DevTools Protocol endpoint in development so external tools
// (chrome://inspect, puppeteer, `curl http://localhost:9222/json`) can attach
// to the running renderer without restarting. Opt-in via OMNI_DEBUG_PORT.
if (process.env.NODE_ENV === 'development' || process.env.OMNI_DEBUG_PORT) {
  const port = process.env.OMNI_DEBUG_PORT ?? '9222';
  app.commandLine.appendSwitch('remote-debugging-port', port);
  // Chromium 111+ requires this to allow non-browser clients to connect.
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  console.log(`[debug] Chrome DevTools Protocol listening on http://localhost:${port}`);
}

const OMNI_CONFIG_DIR = getOmniConfigDir();
const store = getStore();
const secretStore = new ElectronSecretStore();
const { repo, asyncRepo } = openProjectDb();

// One-time migration: move project data from electron-store JSON to SQLite.
// This is idempotent — it skips if the DB already has projects.
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
    console.log(`[ProjectDb] Migrated ${migrated} projects from electron-store to SQLite`);
  }
} catch (err) {
  console.error('[ProjectDb] Failed to migrate from electron-store:', err);
}

// Backfill any project rows whose `config` column is NULL — added in
// schema v3. Idempotent; only touches rows without an existing config.
try {
  const backfilled = backfillProjectConfigs(repo);
  if (backfilled > 0) {
    console.log(`[ProjectDb] Backfilled config for ${backfilled} projects`);
  }
} catch (err) {
  console.error('[ProjectDb] Failed to backfill project configs:', err);
}

// Task #18: copy legacy on-disk pages (`<workspaceDir>/Projects/<slug>/pages`,
// per-project `context.md`, and MCP's `<config>/projects/<slug>/pages`) into
// the new `<config>/pages/<projectId>/` layout. Idempotent; never deletes
// originals so a bad migration can be recovered by hand.
//
// Records a one-shot notice in the store when legacy paths still exist so
// the renderer can show a dismissible cleanup banner. The notice is left
// in place across reboots until the user acknowledges or runs cleanup.
try {
  const summary = migrateLegacyPagesToConfigDir(repo);
  const total = summary.perProjectPagesCopied + summary.rootPagesFromContextMd + summary.mcpPagesCopied;
  if (total > 0) {
    console.log(
      `[ProjectDb] Pages migration copied ${total} files ` +
        `(per-project: ${summary.perProjectPagesCopied}, ` +
        `context.md → root: ${summary.rootPagesFromContextMd}, ` +
        `MCP: ${summary.mcpPagesCopied}, ` +
        `skipped existing: ${summary.skippedAlreadyMigrated})`
    );
  }
  // Only seed the notice on the first boot where we found something
  // worth telling the user about. Subsequent boots leave the existing
  // state alone (so a user mid-decision doesn't get re-prompted).
  const existing = store.get('pagesMigration');
  if (!existing && summary.legacyPaths.length > 0) {
    store.set('pagesMigration', {
      summary: {
        perProjectPagesCopied: summary.perProjectPagesCopied,
        rootPagesFromContextMd: summary.rootPagesFromContextMd,
        mcpPagesCopied: summary.mcpPagesCopied,
        skippedAlreadyMigrated: summary.skippedAlreadyMigrated,
      },
      legacyPaths: summary.legacyPaths,
      acknowledged: false,
    });
  }
} catch (err) {
  console.error('[ProjectDb] Failed to migrate legacy pages:', err);
}

/**
 * Materialize the agent's on-disk config from the store (desktop = single user,
 * plaintext). The store is the source of truth; these files are a derived copy
 * `omni serve` reads. Merges the managed `omni-projects` stdio MCP entry and
 * writes a real `.env`. Runs at startup and after every `settings:*` write.
 */
function materializeDesktopConfig(): void {
  try {
    materializeAgentConfig({
      configDir: OMNI_CONFIG_DIR,
      models: store.get('modelsConfig') ?? emptyModelsConfig(),
      mcp: store.get('mcpConfig') ?? emptyMcpConfig(),
      network: store.get('networkConfig') ?? emptyNetworkConfig(),
      mode: 'plaintext',
      managedMcpEntry: buildStdioMcpEntry(getMcpBinPath()),
    });
    writeFileSync(join(OMNI_CONFIG_DIR, '.env'), store.get('envVars') ?? '', 'utf-8');
  } catch (err) {
    console.error('[config-materializer] desktop materialize failed:', err);
  }
}

// Import any pre-v23 on-disk config files into the store once, then make the
// store the source of truth that materialize writes back out.
migrateAgentConfigFromFiles(store, OMNI_CONFIG_DIR);
materializeDesktopConfig();

const main = new MainProcessManager({ store });
let isShuttingDown = false;

// Forward-reference for the BrowserManager — created further down, but
// AppControlManager needs its popup callback at construction time so
// `setWindowOpenHandler` can route `window.open` into `BrowserManager.createTab`.
let browserManagerRef: ReturnType<typeof createBrowserManager>[0] | null = null;
const [appControlManager, cleanupAppControl] = createAppControlManager({
  ipc: main.ipc,
  onBrowserPopup: (tabsetId, url, disposition) => {
    if (!browserManagerRef) {
      return;
    }
    // `background-tab` maps to Cmd/Ctrl+click: open without stealing focus.
    // Everything else (`foreground-tab`, `new-window`, `default`) activates.
    const activate = disposition !== 'background-tab';
    try {
      browserManagerRef.createTab(tabsetId, { url, activate });
    } catch {
      // Tabset may not exist yet (race on first mount) — ignore.
    }
  },
});
const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const [processManager, cleanupProcessManager] = createProcessManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  fetchFn: (input, init) => net.fetch(input as string, init),
  getStoreData: () => ({
    defaultProfileName: store.get('defaultProfileName') ?? 'host',
    projects: repo.listProjects().map(rowToProject),
    gitCredentials: store.get('gitCredentials') ?? [],
  }),
  resolveGitToken: (id) => secretStore.getGitToken(id),
});

// Create ConsoleManager — proxies terminal:* IPC into omni serve's
// WebSocket. Constructed after ProcessManager because it needs the
// agent process status to find the right WS URL per tab.
const [, cleanupConsole] = createConsoleManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  processManager,
});

registerSnapshotHandlers(main.ipc);

// Startup snapshot GC. Code tabs cascade-delete on remove; this sweep
// catches chat snapshots older than 14 days (and any code-tab tar
// orphaned by a crashed cascade). Protected set = active chatSessionId
// + every code tab's sessionId. Best-effort; failures don't block boot.
void (async () => {
  try {
    const keep = new Set<string>();
    const chatSessionId = store.get('chatSessionId');
    if (chatSessionId) {
      keep.add(chatSessionId);
    }
    for (const tab of store.get('codeTabs') ?? []) {
      if (tab.sessionId) {
        keep.add(tab.sessionId);
      }
    }
    const deleted = await gcStaleSnapshots({ keep, ttlMs: DEFAULT_CHAT_SNAPSHOT_TTL_MS });
    if (deleted.length > 0) {
      console.log(`[snapshot-gc] deleted ${deleted.length} stale snapshot(s)`);
    }
  } catch (err) {
    console.error('[snapshot-gc] failed:', err);
  }
})();
const [projectManager, cleanupProject] = createProjectManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  processManager,
  appControlManager,
  // Async repo backs the cached projection; sync repo drives the change-watcher.
  repo: asyncRepo,
  changeSeqRepo: repo,
});
// Wire up the store snapshot provider so MainProcessManager serves project data from SQLite
main.getStoreSnapshot = () => projectManager.getStoreSnapshot();
const [, cleanupExtensions] = createExtensionManager({
  ipc: main.ipc,
  store,
  sendToWindow: main.sendToWindow,
});
const [browserManager, cleanupBrowser] = createBrowserManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
});
browserManagerRef = browserManager;
const [, cleanupDownloads] = createDownloadsManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const [, cleanupPermissions] = createPermissionsManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
});
const { cleanup: cleanupPlatform, refreshPolicy: refreshPlatformPolicy } = registerPlatformIpc({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  store,
  fetchFn: (input, init) => net.fetch(input as string, init),
});

// Keep ProcessManager's platform client in sync with auth state.
// On sign-in/sign-out, the platform client is updated so new sandboxes
// use the correct mode without requiring an app restart.
const platformFetchFn = (input: string | URL | Request, init?: RequestInit) => net.fetch(input as string, init);

/** Attach onTokenRefresh so refreshed access tokens are persisted to the store. */
const withTokenPersistence = (client: ReturnType<typeof createPlatformClient>) => {
  if (client) {
    client.onTokenRefresh = (newAccessToken) => {
      const current = store.get('platform');
      if (current) {
        store.set('platform', { ...current, accessToken: newAccessToken });
      }
    };
  }
  return client;
};

const syncPlatformClients = (platform?: Parameters<typeof createPlatformClient>[0]) => {
  const client = withTokenPersistence(createPlatformClient(platform, platformFetchFn));
  processManager.platformClient = client;
};
syncPlatformClients(store.get('platform'));
store.onDidChange('platform', (newVal) => {
  syncPlatformClients(newVal);
});

// Background workspace sync manager — like OneDrive for project workspaces.
const syncManager = new WorkspaceSyncManager({
  fetchFn: platformFetchFn,
  platformClient: processManager.platformClient,
  manifestDir: OMNI_CONFIG_DIR,
  onStatusChange: (projectId, status) => {
    main.sendToWindow('workspace-sync:status-changed', projectId, status);
  },
});
store.onDidChange('platform', () => {
  syncManager.setPlatformClient(processManager.platformClient);
});

// On startup, refresh platform policy if already signed in.
// This ensures sandbox profiles are up-to-date with the latest entitlements.
void refreshPlatformPolicy();

main.ipc.handle('main-process:get-status', () => main.getStatus());

// Workspace sync IPC handlers
main.ipc.handle('workspace-sync:start', (_, projectId, workspaceDir) => {
  return syncManager.startSync(projectId, workspaceDir);
});
main.ipc.handle('workspace-sync:stop', (_, projectId) => {
  return syncManager.stopSync(projectId);
});
main.ipc.handle('workspace-sync:get-status', (_, projectId) => {
  return syncManager.getStatus(projectId);
});
main.ipc.handle('workspace-sync:get-share-name', (_, projectId) => {
  return syncManager.getShareName(projectId);
});
main.ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());

//#region App lifecycle

/**
 * Cleans up any running processes.
 */
async function cleanup() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  cleanupPlatform();
  await syncManager.dispose();
  const results = await Promise.allSettled([
    cleanupConsole(),
    cleanupAppControl(),
    cleanupOmniInstall(),
    cleanupProcessManager(),
    cleanupProject(),
    cleanupExtensions(),
    cleanupBrowser(),
    cleanupDownloads(),
    cleanupPermissions(),
  ]);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);

  if (errors.length > 0) {
    console.error('Error cleaning up processes:', errors);
  } else {
    console.debug('Successfully cleaned up all processes');
  }
  closeProjectDb();
  main.cleanup();
}

/**
 * This method will be called when Electron has finished initialization and is ready to create browser windows.
 * Some APIs can only be used after this event occurs.
 */
app.on('ready', () => {
  // Register artifact: protocol handler for serving ticket artifact files
  // URL format: artifact://file/{ticketId}/{relativePath}
  // We use a dummy hostname ("file") because URL spec lowercases hostnames,
  // which corrupts case-sensitive ticket IDs like nanoid.
  // MCP Apps sandbox proxy. Serves the vendored mcp-ui ``index.html``
  // (assets/mcp-sandbox/) at ``mcp-sandbox://app/index.html``. The
  // AppFrame iframe loads this URL to host a cross-origin sandbox for
  // MCP-Apps tool UIs. CSP allows inline script (the proxy itself is a
  // small inline script) but blocks network loads — guest HTML is
  // delivered to the proxy via postMessage and written into a nested
  // iframe via document.write, where it runs without script privileges
  // unless the inner iframe's sandbox attribute permits it.
  protocol.handle('mcp-sandbox', async (request) => {
    try {
      const url = new URL(request.url);
      // Only one resource is served — any path returns the same HTML.
      // The query string is preserved by the browser and read by the
      // proxy script (contentType=rawhtml or ?url=...).
      void url;
      const htmlPath = getMcpSandboxHtmlPath();
      const upstream = await net.fetch(pathToFileURL(htmlPath).toString());
      const headers = new Headers(upstream.headers);
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.set(
        'Content-Security-Policy',
        // ``script-src 'unsafe-inline' https:`` lets renderer-HTML import
        // its component runtime from a CDN (Prefab's renderer loads from
        // ``cdn.jsdelivr.net``, generative-ui-style apps may pull from
        // other origins). ``style-src`` mirrors so stylesheets load.
        // ``font-src`` + ``img-src`` permit referenced assets;
        // ``connect-src`` permits any fetch/XHR/WebSocket the renderer
        // makes back to its own backend. ``frame-src https: http:`` keeps
        // MCP-Apps ``externalUrl`` (text/uri-list) embedding working.
        [
          "default-src 'none'",
          "script-src 'unsafe-inline' https:",
          "style-src 'unsafe-inline' https:",
          'font-src https: data:',
          'img-src https: data: blob:',
          'connect-src https: wss: ws: data: blob:',
          'frame-src about: data: blob: https: http:',
        ].join('; ')
      );
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  protocol.handle('artifact', async (request) => {
    try {
      const url = new URL(request.url);
      // pathname = /file/{ticketId}/{relativePath...}  or  /{ticketId}/{relativePath...}
      const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      // Skip the dummy hostname segment if present
      const startIdx = segments[0] === 'file' ? 1 : 0;
      const ticketId = segments[startIdx];
      const relativePath = segments.slice(startIdx + 1).join('/');
      if (!ticketId || !relativePath) {
        return new Response('Bad request', { status: 400 });
      }
      const artifactsRoot = getArtifactsDir(OMNI_CONFIG_DIR, ticketId);
      const fullPath = resolve(artifactsRoot, relativePath);
      // Path traversal protection
      if (!fullPath.startsWith(artifactsRoot)) {
        return new Response('Forbidden', { status: 403 });
      }
      const upstream = await net.fetch(pathToFileURL(fullPath).toString());
      // Strict CSP: artifacts are agent-generated content, never trusted to
      // run scripts. `default-src 'none'` blocks script execution by default;
      // we explicitly re-enable images, styles, fonts, and media so typical
      // markdown/HTML artifacts still render.
      const headers = new Headers(upstream.headers);
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
      );
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  main.createWindow();

  if (process.env.OMNI_CI_AUTOINSTALL) {
    void (async () => {
      console.log('[OMNI_CI] starting auto-install');
      try {
        await omniInstall.startInstall();
      } catch (err) {
        console.error('[OMNI_CI] startInstall threw:', err);
      }
      const status = omniInstall.getStatus();
      console.log(`[OMNI_CI] final status: ${status.type}`);
      app.exit(status.type === 'completed' ? 0 : 1);
    })();
  }

  // Ensure workspace and projects directories exist on startup
  void ensureDirectory(getDefaultWorkspaceDir())
    .then(() => ensureDirectory(getProjectsDir()))
    .catch((err) => console.warn('Failed to create workspace directories:', err));

  void (async () => {
    const { cleanupOrphanedContainers, pruneDockerResources } = await import('@/main/docker-orphan-cleanup');
    const cleaned = await cleanupOrphanedContainers();
    if (cleaned > 0) {
      main.sendToWindow('toast:show', {
        level: 'info',
        title: 'Cleaned up orphaned containers',
        description: `Removed ${cleaned} Docker container${cleaned === 1 ? '' : 's'} from a previous session.`,
      });
    }

    const reclaimed = await pruneDockerResources();
    if (reclaimed && reclaimed !== '0B') {
      main.sendToWindow('toast:show', {
        level: 'info',
        title: 'Docker storage reclaimed',
        description: `Pruned unused Docker resources, reclaimed ${reclaimed}.`,
      });
    }
  })().catch((error) => {
    console.warn('Failed to clean up Docker resources:', error);
  });
});

/**
 * Quit when all windows are closed.
 */
app.on('window-all-closed', () => {
  if (!isShuttingDown) {
    app.quit();
  }
});

/**
 * When the launcher quits, cleanup any running processes.
 * We prevent the default quit, await all cleanup (which uses SIGTERM → SIGKILL internally),
 * then force-exit the app. A hard 15s timeout ensures the app never hangs indefinitely.
 */
app.on('before-quit', (event) => {
  if (isShuttingDown) {
    return;
  }

  event.preventDefault();

  // Hard timeout: if cleanup hangs, force-exit the process
  const forceExitTimer = setTimeout(() => {
    console.error('Cleanup timed out after 15s, forcing exit');
    app.exit(1);
  }, 15_000);

  cleanup().finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
});

//#endregion

//#region Shared IPC handlers (config:*, util:*, skills:*)

registerConfigHandlers(main.ipc, OMNI_CONFIG_DIR);
registerUtilHandlers(main.ipc, {
  fetchFn: ((input, init) => net.fetch(input as string, init)) as typeof globalThis.fetch,
  launcherVersion: app.getVersion(),
});
registerSkillsHandlers(
  main.ipc,
  () => OMNI_CONFIG_DIR,
  () => store
);
registerSettingsConfigHandlers(
  main.ipc,
  () => store,
  () => {
    materializeDesktopConfig();
    main.sendToWindow('store:changed', main.getStoreSnapshot ? main.getStoreSnapshot() : store.store);
  }
);
registerGitCredentialHandlers(
  main.ipc,
  () => store,
  () => secretStore,
  () => {
    main.sendToWindow('store:changed', main.getStoreSnapshot ? main.getStoreSnapshot() : store.store);
  }
);
// Desktop has no teams — register the channels as no-ops (controlPlane undefined)
// so the shared renderer's Teams UI resolves cleanly to "just you".
registerTeamHandlers(main.ipc, undefined);
const noTeamDefaults = { hasModels: false, hasMcp: false, hasEnv: false, hasNetwork: false };
main.ipc.handle('team-settings:status', () => noTeamDefaults);
main.ipc.handle('team-settings:publish-from-mine', () => noTeamDefaults);
main.ipc.handle('team-settings:clear', () => noTeamDefaults);
// Desktop has no teams — these resolve to "just you".
main.ipc.handle('team:whoami', () => null);
main.ipc.handle('team:leave', () => []);
main.ipc.handle('team:rename', () => []);
main.ipc.handle('team:delete', () => []);
main.ipc.handle('team:transfer-ownership', () => []);
registerMigrationHandlers(main.ipc, () => ({
  get: () => store.get('pagesMigration') ?? null,
  set: (value) => {
    if (value === null) {
      store.delete('pagesMigration');
    } else {
      store.set('pagesMigration', value);
    }
    // Renderer mirrors electron-store via `store:changed`; pushing the
    // full snapshot keeps the migration banner reactive without a
    // dedicated event channel.
    main.getWindow()?.webContents.send('store:changed', store.store);
  },
}));

//#endregion

//#region Electron-only util handlers (dialog, shell)

main.ipc.handle('util:select-directory', async (_, path) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isDirectory(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });

  return result.filePaths[0] ?? null;
});
main.ipc.handle('util:select-file', async (_, path, filters) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isFile(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    defaultPath,
    filters: filters ?? undefined,
  });

  return result.filePaths[0] ?? null;
});
main.ipc.handle('util:open-directory', (_, path) => shell.openPath(path));
main.ipc.handle('util:open-external', (_, url) => shell.openExternal(url));

//#endregion

//#region Codex (ChatGPT OAuth) handlers

main.ipc.handle('codex:login', () => loginWithBrowser((url) => void shell.openExternal(url)));
main.ipc.handle('codex:link', () =>
  loginWithDeviceFlow({ onCode: (code) => main.sendToWindow('codex:device-code', code) })
);
main.ipc.handle('codex:logout', () => codexLogout());
main.ipc.handle('codex:status', () => codexStatus());

//#endregion

//#region GitHub account linking (OAuth device flow → github.com credential)

// Stable credential id for the OAuth-linked github.com token, so link / unlink /
// clone-time injection all reference the same SecretStore slot.
const GITHUB_CRED_ID = 'github-oauth';
const githubFetch = ((input, init) => net.fetch(input as string, init)) as typeof globalThis.fetch;

const broadcastStore = (): void =>
  main.sendToWindow('store:changed', main.getStoreSnapshot ? main.getStoreSnapshot() : store.store);

const githubStatus = (): GithubStatus => {
  const account = store.get('githubAccount');
  return account ? { connected: true, account } : { connected: false };
};

main.ipc.handle('github:status', () => githubStatus());

main.ipc.handle('github:link', async () => {
  const { token, account } = await githubLink({
    fetchFn: githubFetch,
    openUrl: (url) => void shell.openExternal(url),
    onCode: (code) => main.sendToWindow('github:device-code', code),
  });
  // The token becomes the host's git credential (replacing any prior entry for
  // that host), so private clone/push works through the same injection path.
  await secretStore.setGitToken(GITHUB_CRED_ID, token);
  const creds = (store.get('gitCredentials') ?? []).filter((c) => c.id !== GITHUB_CRED_ID && c.host !== account.host);
  const cred: GitCredential = {
    id: GITHUB_CRED_ID,
    host: account.host,
    username: 'x-access-token',
    last4: tokenLast4(token),
    label: `@${account.login} (GitHub)`,
    createdAt: Date.now(),
  };
  store.set('gitCredentials', [...creds, cred]);
  store.set('githubAccount', account);
  broadcastStore();
  return githubStatus();
});

main.ipc.handle('github:unlink', async () => {
  await secretStore.deleteGitToken(GITHUB_CRED_ID);
  store.set(
    'gitCredentials',
    (store.get('gitCredentials') ?? []).filter((c) => c.id !== GITHUB_CRED_ID)
  );
  store.delete('githubAccount');
  broadcastStore();
});

const requireGithubToken = async (): Promise<string> => {
  const token = await secretStore.getGitToken(GITHUB_CRED_ID);
  if (!token) {
    throw new Error('No GitHub account linked');
  }
  return token;
};

main.ipc.handle('github:list-owners', async (): Promise<GithubOwner[]> => {
  const token = await requireGithubToken();
  const account = store.get('githubAccount');
  // The linked user is always the first owner; their orgs follow.
  const self: GithubOwner[] = account
    ? [{ login: account.login, kind: 'user', ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) }]
    : [];
  return [...self, ...(await githubListOrgs(githubFetch, token))];
});

main.ipc.handle('github:search-repos', async (_, query: GithubRepoQuery): Promise<RemoteRepo[]> => {
  return githubSearchRepos(githubFetch, await requireGithubToken(), query);
});

//#endregion

//#region Azure DevOps discovery (authenticated by the stored dev.azure.com PAT)

const requireAzureToken = async (): Promise<string> => {
  const cred = (store.get('gitCredentials') ?? []).find((c) => c.host === 'dev.azure.com');
  const token = cred ? await secretStore.getGitToken(cred.id) : undefined;
  if (!token) {
    throw new Error('No Azure DevOps token — add a dev.azure.com credential first');
  }
  return token;
};

main.ipc.handle('azure:list-repos', async (_, input: { org: string; query: string }): Promise<RemoteRepo[]> => {
  return azureListRepos(githubFetch, await requireAzureToken(), input.org, input.query);
});

//#endregion
