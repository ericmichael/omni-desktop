if (process.env.NODE_ENV === 'development') {
  require('dotenv/config');
}

import { app, dialog, ipcMain, net, protocol, shell } from 'electron';
import { existsSync, writeFileSync } from 'fs';
import { migrateFromJson } from 'omni-projects-db';
import { join, resolve } from 'path';
import { assert } from 'tsafe';
import { pathToFileURL } from 'url';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig, parseEnvVars } from '@/lib/agent-config';
import { getArtifactsDir } from '@/lib/artifacts';
import { parseResidentPrincipal } from '@/lib/resident-agent';
import { winToWslPath } from '@/lib/wsl-path';
import { createAppControlManager } from '@/main/app-control-manager';
import { listRepos as azureListRepos } from '@/main/azure-repos';
import { createBrowserManager } from '@/main/browser-manager';
import {
  getStatus as codexStatus,
  loginWithBrowser,
  loginWithDeviceFlow,
  logout as codexLogout,
} from '@/main/codex-auth';
import { wireComputeReverseHandlers } from '@/main/compute-reverse-handlers';
import { migrateAgentConfigFromFiles } from '@/main/config-files-migration';
import { materializeAgentConfig } from '@/main/config-materializer';
import { createConsoleManager } from '@/main/console-manager';
import { rowToProject } from '@/main/db-store-bridge';
import { createDownloadsManager } from '@/main/downloads-manager';
import {
  ensureFreshAccessToken as ensureFreshEntraToken,
  getStatus as entraStatus,
  loginWithDeviceFlow as entraLoginWithDeviceFlow,
  logout as entraLogout,
} from '@/main/entra-auth';
import { createExtensionManager } from '@/main/extension-manager';
import {
  linkWithDeviceFlow as githubLink,
  listOrgs as githubListOrgs,
  searchRepos as githubSearchRepos,
} from '@/main/github-auth';
import { durableLocalCodexAgentHostEnv, LocalCodexAccountOwner } from '@/main/local-codex-account-owner';
import { durableLocalMcpAgentHostEnv, LocalMcpConfigOwner } from '@/main/local-mcp-config-owner';
import { getOrCreateMachineIdentity, renameMachine } from '@/main/machine-identity';
import { MainProcessManager } from '@/main/main-process-manager';
import { getMcpBinPath } from '@/main/mcp-config-manager';
import { registerMigrationHandlers } from '@/main/migration-handlers';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { migrateLegacyPagesToConfigDir } from '@/main/pages-relocation-migration';
import { createPermissionsManager } from '@/main/permissions-manager';
import { registerPlatformIpc } from '@/main/platform-ipc';
import { createPlatformClient } from '@/main/platform-mode';
import { createProcessManager } from '@/main/process-manager';
import { refreshProductRuntimeInfo } from '@/main/product-runtime';
import { registerProfileCatalogHandlers } from '@/main/profile-catalog';
import { getBundledProfilesDir } from '@/main/profile-resolver';
import { backfillProjectConfigs } from '@/main/project-config-backfill';
import { closeProjectDb, getDb, openProjectDb } from '@/main/project-db';
import { createProjectManager } from '@/main/project-manager';
import { registerResidentHandlers, ResidentAgentManager } from '@/main/resident-agent-manager';
import { wireReverseRpcRouter } from '@/main/reverse-rpc-bridge';
import { RoutineBridge } from '@/main/routine-bridge';
import {
  defaultSandboxInventoryDeps,
  processOwnersFromState,
  registerSandboxInventoryHandlers,
} from '@/main/sandbox-inventory';
import { registerScheduledTaskHandlers, ScheduledTaskManager } from '@/main/scheduled-task-manager';
import { LocalSecretStore } from '@/main/secret-store';
import {
  DEFAULT_CHAT_SNAPSHOT_TTL_MS,
  gcStaleSnapshots,
  protectedSnapshotsFromTabs,
  registerSnapshotHandlers,
} from '@/main/snapshot-manager';
import { reconcilePendingSnapshotUploads } from '@/main/snapshot-upload-ledger';
import { getStore } from '@/main/store';
import { wireTunnelReverseHandlers } from '@/main/tunnel-handler';
import {
  ensureDirectory,
  getDefaultWorkspaceDir,
  getMcpSandboxHtmlPath,
  getOmniConfigDir,
  getProjectsDir,
  isDirectory,
  isFile,
} from '@/main/util';
import { getVoiceService } from '@/main/voice-service';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { createWslBackendManager } from '@/main/wsl-backend';
import { registerTeamHandlers } from '@/server/team-handlers';
import { tokenLast4 } from '@/shared/git-credentials';
import {
  registerConfigHandlers,
  registerGitCredentialHandlers,
  registerSettingsConfigHandlers,
  registerSkillsHandlers,
  registerUtilHandlers,
} from '@/shared/ipc-handlers';
import { buildStdioMcpEntry } from '@/shared/mcp-entry';
import type { GitCredential, GithubOwner, GithubRepoQuery, GithubStatus, RemoteRepo, TicketId } from '@/shared/types';

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

// Chromium caps a renderer at 6 sockets per host. The shared AgentHost puts
// EVERY column's chat WS, terminal WS, realtime WS, and ticket fetch on one
// loopback origin, so the 7th connection — typically a reconnect's
// /auth/ws-ticket fetch — queues in the socket pool forever and the column
// hangs at "Connecting…" with zero packets on the wire. Lift the cap for
// loopback only; remote origins keep Chromium's default limits.
app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost');

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
const secretStore = new LocalSecretStore();
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
 * plaintext). Models/network/env remain Desktop-owned; mcp.json is a derived
 * copy only until the local MCP ownership marker transfers it to Omniagents.
 * Merges the managed `omni-projects` stdio MCP entry and writes a real `.env`.
 * Runs at startup and after every `settings:*` write.
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
      writeMcp: store.get('mcpConfigOwnership') !== 'omniagents',
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
let localMcpConfigOwner: LocalMcpConfigOwner;
let localMcpOwnershipPromise: Promise<void> | null = null;
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
  waitForRuntimeInstall: () => omniInstall.waitForInstallCompletion(),
  // Inject the user's Settings → Environment vars into the `omni serve` process
  // (the agent/model loop), mirroring server mode's getExtraEnv. The sandbox
  // *container* gets these separately via the materialized `<config>/.env`,
  // which omni serve folds into manifest.environment (`_inject_user_env`).
  // Trusted local-Electron topology attestation. Deliberately overrides a
  // user-authored value; server managers never inject it and keep the broker
  // account-mutation gate disabled.
  getExtraEnv: () =>
    durableLocalMcpAgentHostEnv(durableLocalCodexAgentHostEnv(parseEnvVars(store.get('envVars') ?? ''))),
  durableLocalCodexAccountMutations: true,
  durableLocalMcpMutations: true,
  prepareLocalMcpOwnership: (status) => ensureLocalMcpOwnership(status),
  onManagementReady: async (proc) => {
    try {
      await ensureLocalMcpOwnership(await proc.getManagementMcpStatus());
    } catch (error) {
      // Keep the management read surface available during migration. The
      // canonical mutation broker still reruns the same parity proof and
      // fails closed until it succeeds.
      console.warn(`[mcp-ownership] local transfer deferred: ${(error as Error).message}`);
    }
  },
});
localMcpConfigOwner = new LocalMcpConfigOwner({
  store,
  managedEntry: buildStdioMcpEntry(getMcpBinPath()),
  environment: () => ({ ...process.env, ...parseEnvVars(store.get('envVars') ?? '') }),
});
/** Complete the local MCP ownership transfer once the management host is
 * ready. The transfer is fail-closed and idempotent; legacy reads can still
 * render while a cold host is starting. */
function ensureLocalMcpOwnership(status?: Record<string, unknown>): Promise<void> {
  if (store.get('mcpConfigOwnership') === 'omniagents') {
    return Promise.resolve();
  }
  if (!localMcpOwnershipPromise) {
    localMcpOwnershipPromise = (status ? Promise.resolve(status) : processManager.getManagementMcpStatus())
      .then((current) => localMcpConfigOwner.ensureOwnership(current))
      .then(() => {
        main.sendToWindow('store:changed', main.getStoreSnapshot ? main.getStoreSnapshot() : store.store);
      })
      .finally(() => {
        localMcpOwnershipPromise = null;
      });
  }
  return localMcpOwnershipPromise;
}
const localCodexAccount = new LocalCodexAccountOwner({
  store,
  runtime: {
    status: () => processManager.getManagementAccountStatus(),
    mutate: (request) => processManager.mutateManagement(request),
  },
  legacy: {
    status: codexStatus,
    login: () => loginWithBrowser((url) => void shell.openExternal(url)),
    link: (onCode) => loginWithDeviceFlow({ onCode }),
    logout: codexLogout,
  },
});
const routineBridge = new RoutineBridge(main.sendToWindow);
const scheduledTaskManager = new ScheduledTaskManager({
  store,
  bridge: routineBridge,
  sendToWindow: main.sendToWindow,
  // Composed snapshot for broadcasts — read at call time; getStoreSnapshot
  // is assigned after ProjectManager boots.
  getSnapshot: () => (main.getStoreSnapshot ? main.getStoreSnapshot() : store.store),
});
const scheduledTaskChannels = [
  ...registerScheduledTaskHandlers(main.ipc, () => scheduledTaskManager),
  ...routineBridge.registerIpc(main.ipc),
];
scheduledTaskManager.start();

// Resident agents (docs/resident-agents-plan.md): the roster of named,
// persistent work agents. Rides ProcessManager for lifecycle; durable
// data lives in projects-db (docs/residents-in-projects-db-plan.md).
const residentAgentManager = new ResidentAgentManager({
  store,
  repo: asyncRepo,
  processManager,
  sendToWindow: main.sendToWindow,
  // Live UI updates: MainProcessManager suppresses the automatic
  // store:changed broadcast once the SQLite snapshot provider is set, so
  // this manager broadcasts its own writes with the MERGED snapshot
  // (project keys included). Read at call time — getStoreSnapshot is
  // assigned after ProjectManager boots.
  getSnapshot: () => (main.getStoreSnapshot ? main.getStoreSnapshot() : store.store),
});
registerResidentHandlers(main.ipc, () => residentAgentManager);
residentAgentManager.start();

// Create ConsoleManager — proxies terminal:* IPC into omni serve's
// WebSocket. Constructed after ProcessManager because it needs the
// agent process status to find the right WS URL per tab.
const [, cleanupConsole] = createConsoleManager({
  ipc: main.ipc,
  sendToWindow: main.sendToWindow,
  processManager,
});

// Protected set = the same open-tab snapshots as the GC keep set below; the
// tab-close cascade persists the pruned codeTabs before its snapshot:delete,
// so the guard only ever blocks deletes of snapshots still open in the UI.
registerSnapshotHandlers(main.ipc, {
  getProtectedSnapshots: () => protectedSnapshotsFromTabs(store.get('codeTabs') ?? []),
});

// Sandboxes tab (docs/sandboxes-tab-plan.md Phase 2): profile discovery +
// container inventory. Both modules are Electron-free; this shell injects
// its paths and ownership providers.
registerProfileCatalogHandlers(main.ipc, {
  bundledDir: getBundledProfilesDir(),
  userDir: join(OMNI_CONFIG_DIR, 'sandbox'),
  getAvailableProfileNames: () => store.get('availableSandboxProfiles'),
});
registerSandboxInventoryHandlers(main.ipc, {
  ...defaultSandboxInventoryDeps(),
  getProcessOwners: () =>
    processOwnersFromState(
      processManager.getContainerOwners(),
      store.get('codeTabs') ?? [],
      residentAgentManager.getDurableSnapshot().residentAgents
    ),
});

// Startup snapshot upload recovery + GC. Code tabs cascade-delete on remove; this sweep
// catches stale conversation snapshots older than 14 days (and any tar
// orphaned by a crashed cascade). Protected set = every code tab's
// snapshotRef. Best-effort; failures
// don't block boot.
void (async () => {
  try {
    const recovery = await reconcilePendingSnapshotUploads(join(OMNI_CONFIG_DIR, 'snapshots'), { force: true });
    if (recovery.persisted.length > 0) {
      console.log(`[snapshot-upload] recovered ${recovery.persisted.length} pending snapshot upload(s)`);
    }
    if (recovery.forcedUncertain.length > 0) {
      console.warn(`[snapshot-upload] ${recovery.forcedUncertain.length} forced-shutdown snapshot(s) remain uncertain`);
    }
  } catch (err) {
    console.error('[snapshot-upload] startup reconciliation failed:', err);
  }
  try {
    const keep = new Set<string>();
    for (const tab of store.get('codeTabs') ?? []) {
      if (tab.snapshotRef) {
        keep.add(tab.snapshotRef);
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
  // Resident durable keys ride EVERY snapshot this manager builds or
  // broadcasts — a project-data broadcast without them would clobber the
  // roster in the renderer's mirrored store.
  snapshotExtras: () => residentAgentManager.getDurableSnapshot(),
  // Ticket assigned to a resident (`agent:<id>`) → assignment wakeup.
  onAssign: (assignee, ticket) => {
    const residentId = parseResidentPrincipal(assignee);
    if (!residentId) {
      return;
    }
    const project = projectManager.getStoreSnapshot().projects.find((p) => p.id === ticket.projectId);
    residentAgentManager.deliverAssignment(residentId, {
      id: ticket.id,
      title: ticket.title,
      ...(project ? { projectLabel: project.label } : {}),
    });
  },
});
// Wire up the store snapshot provider so MainProcessManager serves project data
// from SQLite. Resident durable keys ride along via ProjectManager's
// snapshotExtras, so this single snapshot is complete everywhere it's used.
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
// WSL backend daemon lifecycle (Windows only; docs/windows-wsl-backend-plan.md).
// Created unconditionally so `wsl:detect` works pre-link; the daemon itself
// only boots when `store.remoteBackend.kind === 'wsl'` (see the app-ready
// sequencing below). Non-Windows platforms no-op inside the manager.
// Persistent daemon mode signs tokens with a durable secret kept in the
// LocalSecretStore under a stable id, so a daemon that outlived the previous
// app session can be adopted on the next boot.
const WSL_BACKEND_SECRET_ID = 'wsl-backend-secret';
const [wslBackend, cleanupWslBackend] = createWslBackendManager({
  store,
  sendToWindow: main.sendToWindow,
  launcherVersion: app.getVersion(),
  secrets: {
    getSecret: async () => (await secretStore.getGitToken(WSL_BACKEND_SECRET_ID)) ?? null,
    setSecret: (value) => secretStore.setGitToken(WSL_BACKEND_SECRET_ID, value),
    deleteSecret: () => secretStore.deleteGitToken(WSL_BACKEND_SECRET_ID),
  },
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
  return client;
};
let platformClient = syncPlatformClients(store.get('platform'));
store.onDidChange('platform', (newVal) => {
  platformClient = syncPlatformClients(newVal);
});

// Background workspace sync manager — like OneDrive for project workspaces.
const syncManager = new WorkspaceSyncManager({
  fetchFn: platformFetchFn,
  platformClient,
  manifestDir: OMNI_CONFIG_DIR,
  onStatusChange: (projectId, status) => {
    main.sendToWindow('workspace-sync:status-changed', projectId, status);
  },
});
store.onDidChange('platform', () => {
  syncManager.setPlatformClient(platformClient);
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

// Local voice (Option A): launcher-side STT/TTS via the ONNX sidecar. Works in
// every Electron mode (compute runs wherever, but the mic + STT/TTS + the
// `speak` client tool all execute here on the user's machine).
const voice = getVoiceService();
main.ipc.handle('voice:get-status', () => voice.getStatus());
main.ipc.handle('voice:start', async () => {
  await voice.start();
  return voice.getStatus();
});
main.ipc.handle('voice:transcribe', (_e, pcmBase64, sampleRate) => voice.transcribe(pcmBase64, sampleRate));
main.ipc.handle('voice:speak', async (_e, streamId, text, voiceName) => {
  await voice.speak(
    text,
    (pcm, sampleRate) => main.sendToWindow('voice:audio', { streamId, pcm, sampleRate }),
    voiceName
  );
  main.sendToWindow('voice:audio-end', { streamId });
});
main.ipc.handle('voice:import-sample', (_e, personaId, filename, dataBase64) =>
  voice.importSample(personaId, filename, dataBase64)
);

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
  cleanupReverseRpc();
  cleanupComputeReverse();
  cleanupTunnelReverse();
  // Non-persistent mode: kills the wsl.exe child, terminating the in-distro
  // daemon. Persistent mode: only stops timers/loops — the daemon keeps
  // running and is adopted on the next boot.
  cleanupWslBackend();
  await syncManager.dispose();
  const results = await Promise.allSettled([
    cleanupConsole(),
    cleanupAppControl(),
    cleanupOmniInstall(),
    (async () => {
      scheduledTaskManager.stop();
      routineBridge.disposeAll();
      for (const channel of scheduledTaskChannels) {
        ipcMain.removeHandler(channel);
      }
    })(),
    residentAgentManager.cleanup(),
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
  // Introspect the installed product (`<prog> describe --json`) so identity
  // and config-dir consumers use the product-reported values. Best-effort:
  // convention-based fallbacks cover the not-yet-installed case.
  void refreshProductRuntimeInfo();

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
      // Container substrates write artifacts inside the sandbox, not to the
      // host dir — materialize (docker cp into this exact layout) before
      // serving so image/HTML previews work there too. Host profile: the
      // file already exists and this resolves to it directly.
      if (!existsSync(fullPath)) {
        await projectManager.materializeArtifact(ticketId as TicketId, relativePath);
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

  // WSL backend boot sequencing: provision → reap → spawn → health-wait
  // BEFORE the window exists, because the renderer's bootstrap URL
  // (main-process-manager.ts) derives from the port boot() persists into
  // `store.remoteBackend`. boot() never throws and caps its wait (120s when
  // it provisioned this boot, else 30s) — on timeout or daemon failure the
  // window is created anyway; the WS transport auto-reconnects and the
  // settings card surfaces the error status.
  void (async () => {
    const backend = store.get('remoteBackend');
    if (backend?.kind === 'wsl') {
      await wslBackend.boot(backend);
    }
    main.createWindow();
  })();

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
    const cleaned = await cleanupOrphanedContainers({
      // Environments already materialized by this launcher may overlap the
      // startup sweep, so resolve the live protected set immediately before
      // each removal pass.
      getProtectedContainerIds: () => processManager.getAllContainerIds(),
    });
    if (cleaned && cleaned.length > 0) {
      main.sendToWindow('toast:show', {
        level: 'info',
        title: 'Cleaned up orphaned containers',
        description: `Removed ${cleaned.length} Docker container${cleaned.length === 1 ? '' : 's'} from a previous session.`,
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
 * Run cleanup with a hard timeout, then exit. Shared by before-quit and the
 * POSIX signal handlers below.
 */
function shutdownWithTimeout() {
  // Hard timeout: if cleanup hangs, force-exit the process
  const forceExitTimer = setTimeout(() => {
    console.error('Cleanup timed out after 15s, forcing exit');
    app.exit(1);
  }, 15_000);

  cleanup().finally(() => {
    clearTimeout(forceExitTimer);
    app.exit(0);
  });
}

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
  shutdownWithTimeout();
});

// Ctrl+C in a dev terminal (`npm run dev`) or a plain `kill`: route through
// the same cleanup as before-quit. Chromium's own signal handling tears the
// process down without reliably emitting the quit events, so handle the
// signals in Node land. A second signal while cleanup is in flight forces an
// immediate exit — the serve children were signalled too (same foreground
// process group) and finish their own teardown regardless.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (isShuttingDown) {
      app.exit(1);
      return;
    }
    console.log(`Received ${sig}, cleaning up...`);
    shutdownWithTimeout();
  });
}

//#endregion

//#region Shared IPC handlers (config:*, util:*, skills:*)

registerConfigHandlers(main.ipc, OMNI_CONFIG_DIR, {
  beforeWrite: (filePath) => {
    if (
      store.get('mcpConfigOwnership') === 'omniagents' &&
      resolve(filePath) === resolve(OMNI_CONFIG_DIR, 'mcp.json')
    ) {
      throw new Error('Omniagents owns mcp.json; use the canonical per-server MCP controls');
    }
  },
});
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
  },
  {},
  {
    // Reading the legacy document must remain responsive while a cold
    // management host starts. Ownership is transferred by the readiness hook
    // above; this guard only blocks writes after the marker is durable.
    beforeSetMcp: () => {
      if (store.get('mcpConfigOwnership') === 'omniagents') {
        throw new Error('Omniagents owns MCP configuration; use the canonical per-server MCP controls');
      }
    },
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

/**
 * WSL-backend path translation, at this single boundary only (plan Phase 4):
 * native dialogs return Windows paths, but in WSL mode the renderer and the
 * daemon only ever see Linux paths. A pick that doesn't translate (e.g. a
 * non-WSL UNC share) maps to `null` — the same shape as a cancelled dialog.
 */
const toBackendPath = (path: string | null): string | null => {
  if (path === null || store.get('remoteBackend')?.kind !== 'wsl') {
    return path;
  }
  return winToWslPath(path);
};

main.ipc.handle('util:select-directory', async (_, path) => {
  const mainWindow = main.getWindow();
  assert(mainWindow !== null, 'Main window is not initialized');

  const defaultPath = path && (await isDirectory(path)) ? path : app.getPath('home');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });

  return toBackendPath(result.filePaths[0] ?? null);
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

  return toBackendPath(result.filePaths[0] ?? null);
});
main.ipc.handle('util:open-directory', (_, path) => shell.openPath(path));
main.ipc.handle('util:open-external', (_, url) => shell.openExternal(url));

//#endregion

//#region Codex (ChatGPT OAuth) handlers

main.ipc.handle('codex:login', () => localCodexAccount.login());
main.ipc.handle('codex:link', () => localCodexAccount.link((code) => main.sendToWindow('codex:device-code', code)));
main.ipc.handle('codex:logout', () => localCodexAccount.logout());
main.ipc.handle('codex:status', () => localCodexAccount.status());

//#endregion

//#region Cloud link (Electron ↔ deployed launcher via AAD device flow)

// Hoisted from the GitHub block below so both regions can fan store changes
// out to the renderer.
const broadcastStore = (): void =>
  main.sendToWindow('store:changed', main.getStoreSnapshot ? main.getStoreSnapshot() : store.store);

const cloudStatusFromStore = (): import('@/shared/types').CloudStatus => {
  const backend = store.get('remoteBackend');
  if (backend?.kind !== 'cloud') {
    return { connected: false };
  }
  const live = entraStatus();
  // Belt + suspenders: if the secret store has been cleared out (e.g. user
  // wiped userData) treat the remoteBackend flag as stale and report
  // disconnected so the renderer drops back to local mode after a restart.
  if (!live.signedIn) {
    return { connected: false };
  }
  return {
    connected: true,
    url: backend.url,
    tenantId: backend.tenantId,
    clientId: backend.clientId,
    account: backend.account,
  };
};

main.ipc.handle('cloud:status', () => cloudStatusFromStore());

/** Restart the Electron app on a short delay so the IPC reply (the new
 *  ``CloudStatus``) flushes to the renderer first. The transport choice is
 *  baked into the BrowserWindow at creation via ``additionalArguments``, so
 *  flipping the remote backend requires a fresh process — not just a
 *  webContents reload. 200ms is enough for the response handshake without
 *  making the UI feel laggy. */
const restartAfterRemoteBackendChange = (): void => {
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 200);
};

main.ipc.handle('cloud:link', async (_, urlInput) => {
  const url = String(urlInput ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) {
    throw new Error('Cloud URL is required');
  }
  // 1. Discover the cloud's AAD configuration. Public endpoint, no auth.
  const discoverRes = await net.fetch(`${url}/.well-known/omni-cloud`);
  if (!discoverRes.ok) {
    throw new Error(`Cloud discovery failed (${discoverRes.status}). Is this a launcher URL?`);
  }
  const discovered = (await discoverRes.json()) as { tenantId?: string; clientId?: string };
  if (!discovered.tenantId || !discovered.clientId) {
    throw new Error('Cloud discovery returned no tenant/client id');
  }
  // 2. Drive the AAD device-code flow against the discovered tenant + client.
  const result = await entraLoginWithDeviceFlow({
    tenantId: discovered.tenantId,
    clientId: discovered.clientId,
    onCode: (code) => main.sendToWindow('cloud:device-code', code),
  });
  if (!result.signedIn) {
    throw new Error('Cloud sign-in did not produce an account');
  }
  // 3. Persist the remoteBackend flag, then restart so the renderer picks up
  //    the cloud transport on its next boot.
  store.set('remoteBackend', {
    kind: 'cloud',
    url,
    tenantId: discovered.tenantId,
    clientId: discovered.clientId,
    account: result.account,
  });
  broadcastStore();
  const status = cloudStatusFromStore();
  restartAfterRemoteBackendChange();
  return status;
});

// Shared disconnect path for ALL remote-backend kinds (cloud, wsl, server):
// clears the flag and restarts back into standalone-local mode. Entra logout
// only applies to the cloud kind — wsl and server links never signed in.
main.ipc.handle('cloud:unlink', async () => {
  const prev = store.get('remoteBackend');
  if (prev?.kind === 'cloud') {
    entraLogout();
  }
  // A WSL daemon — persistent or not — must not outlive the link: reap it and
  // drop the durable secret so nothing keeps running (or listening) orphaned.
  if (prev?.kind === 'wsl') {
    await wslBackend.unlink(prev.distro);
  }
  store.set('remoteBackend', null);
  broadcastStore();
  // The live renderer is still configured to use the (now broken) backend
  // transport — restart so it falls back to local Electron IPC.
  restartAfterRemoteBackendChange();
});

main.ipc.handle('cloud:get-access-token', async () => {
  const backend = store.get('remoteBackend');
  if (backend?.kind !== 'cloud') {
    throw new Error('Not connected to a cloud');
  }
  return ensureFreshEntraToken(backend.tenantId, backend.clientId);
});

// Stable per-install machine identity used by the cloud's "computer-as-
// sandbox" registry. Lives in `<configDir>/machine.json` so it survives
// upgrades + electron-store resets. Renderer reads this once at boot to
// invoke `machine:register` over the WS to the cloud.
main.ipc.handle('cloud:get-machine-identity', () => {
  return getOrCreateMachineIdentity(OMNI_CONFIG_DIR);
});

main.ipc.handle('cloud:set-machine-label', (_, label) => {
  const next = String(label ?? '').trim() || 'Unnamed machine';
  return renameMachine(OMNI_CONFIG_DIR, next);
});

// Wire the renderer → main reverse-RPC dispatcher (Phase 2). The cloud's
// reverse-invoke frames hit the renderer's WS first; the renderer-side
// shim (`renderer/services/compute.ts`) forwards them here so main-side
// compute handlers can resolve them.
const cleanupReverseRpc = wireReverseRpcRouter(main.ipc);

// Computer-as-sandbox — main handles the cloud's compute:* reverse-RPCs by
// standing up an `omni sandbox-host` exec server (the agent stays in the
// cloud; only the sandbox backend runs here).
const cleanupComputeReverse = wireComputeReverseHandlers();

// Tunnel relay (Phase 3). Inbound WS frames from local omni-serve are
// pushed to the renderer via this Electron IPC event; the renderer's
// tunnel bridge re-emits them on the cloud WS via `tunnel:incoming`.
const cleanupTunnelReverse = wireTunnelReverseHandlers((event) => {
  main.sendToWindow('tunnel:emit-incoming', event);
});

// Fetch a WS auth token from the linked cloud's /api/ws-token. The renderer
// can't do this directly: setting Authorization on a cross-origin GET trips
// CORS preflight, and EasyAuth's 302 redirect for unauthenticated OPTIONS
// requests fails the CORS check. Running the fetch in main bypasses CORS
// entirely (Node's fetch is unrestricted) and returns the opaque WS token.
main.ipc.handle('cloud:get-ws-token', async () => {
  const backend = store.get('remoteBackend');
  if (backend?.kind !== 'cloud') {
    throw new Error('Not connected to a cloud');
  }
  const accessToken = await ensureFreshEntraToken(backend.tenantId, backend.clientId);
  const res = await net.fetch(`${backend.url}/api/ws-token`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Cloud ws-token fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('Cloud ws-token response missing "token" field');
  }
  return data.token;
});

//#endregion

//#region WSL backend (Windows-only daemon lifecycle — docs/windows-wsl-backend-plan.md)

main.ipc.handle('wsl:detect', () => wslBackend.detect());

main.ipc.handle('wsl:status', () => wslBackend.getStatus());

// Signed locally with the daemon's per-boot shared secret — no HTTP fetch
// (Decision 4: shared secret, not network trust).
main.ipc.handle('wsl:get-ws-token', () => wslBackend.getWsToken());

main.ipc.handle('wsl:link', async (_, distroInput) => {
  const distro = String(distroInput ?? '').trim();
  if (!distro) {
    throw new Error('WSL distro name is required');
  }
  const detected = await wslBackend.detect();
  if (detected.wsl !== 'ok' || !detected.distros.some((d) => d.name === distro)) {
    throw new Error(`WSL distro "${distro}" not found`);
  }
  // Provision inline so failures surface to the caller before any restart.
  await wslBackend.provisionIfNeeded(distro);
  // port 0 is a placeholder — boot() re-picks and persists the real port
  // before window creation on the next launch.
  store.set('remoteBackend', { kind: 'wsl', distro, port: 0 });
  broadcastStore();
  restartAfterRemoteBackendChange();
});

// Mode transition: the manager persists the flag into `store.remoteBackend`
// and restarts the daemon into the new lifecycle (tracked child ↔ detached
// nohup) — the settings card copy warns about the restart.
main.ipc.handle('wsl:set-persistent', async (_, persistent) => {
  await wslBackend.setPersistent(Boolean(persistent));
  broadcastStore();
});

// `wsl --install` driven from the app: 'platform' launches an elevated
// one-shot (UAC; completion unobservable), 'distro' registers Ubuntu without
// elevation. The card re-runs `wsl:detect` afterwards — no store change here.
main.ipc.handle('wsl:install', (_, mode) => wslBackend.install(mode === 'platform' ? 'platform' : 'distro'));

// Docker bootstrap inside the linked distro (Sandboxes → Health). Both run
// as root via `wsl -u root` and end by re-running the docker check, so the
// `wsl:status-changed` broadcast refreshes `status.docker`. Require an
// active WSL link — without one the manager has no distro to target.
const requireWslLink = (): void => {
  if (store.get('remoteBackend')?.kind !== 'wsl') {
    throw new Error('No WSL backend is linked');
  }
};
main.ipc.handle('wsl:install-docker', () => {
  requireWslLink();
  return wslBackend.installDocker();
});
main.ipc.handle('wsl:start-docker', () => {
  requireWslLink();
  return wslBackend.startDocker();
});

//#endregion

//#region Self-hosted server link (Electron ↔ user-run server-mode launcher)

// The wsl token flow minus wsl.exe: no Entra, no daemon lifecycle — the user
// runs the server themselves; we only validate reachability + token access
// at link time and fetch WS tokens from it thereafter. Both fetches run in
// main (Node fetch, no CORS) because the server gates /api/ws-token by
// caller address (loopback + OMNI_TRUSTED_CIDRS), not by identity.

/** GET ``<url>/api/ws-token`` and return the opaque token. Shared by link
 *  validation and the steady-state `server:get-ws-token` handler so the 403
 *  guidance (OMNI_TRUSTED_CIDRS) is identical in both. */
const fetchServerWsToken = async (url: string): Promise<string> => {
  let res: Response;
  try {
    res = await net.fetch(`${url}/api/ws-token`);
  } catch (e) {
    throw new Error(`Could not reach ${url}/api/ws-token: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 403) {
    throw new Error(
      `${url} refused to mint a token (403). The server only trusts loopback by default — add this machine's network to OMNI_TRUSTED_CIDRS on the server (e.g. 100.64.0.0/10 for Tailscale).`
    );
  }
  if (!res.ok) {
    throw new Error(`Server ws-token fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('Server ws-token response missing "token" field');
  }
  return data.token;
};

main.ipc.handle('server:link', async (_, urlInput) => {
  const url = String(urlInput ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!url) {
    throw new Error('Server URL is required');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Server URL must start with http:// or https://');
  }
  // Validate BEFORE persisting — a bad URL must not survive into the store,
  // or the next boot dials a dead backend and the app looks bricked.
  let healthRes: Response;
  try {
    healthRes = await net.fetch(`${url}/api/health`);
  } catch (e) {
    throw new Error(
      `Could not reach ${url}/api/health: ${e instanceof Error ? e.message : String(e)}. Is the server running and reachable from this machine?`
    );
  }
  if (!healthRes.ok) {
    throw new Error(`${url}/api/health answered ${healthRes.status}. Is this a launcher server URL?`);
  }
  const health = (await healthRes.json().catch(() => null)) as { ok?: boolean } | null;
  if (health?.ok !== true) {
    throw new Error(`${url}/api/health did not report ok — is this a launcher server URL?`);
  }
  // Token access is the actual gate — proving it now surfaces the
  // OMNI_TRUSTED_CIDRS misconfiguration at link time instead of as a silent
  // WS auth loop after the relaunch.
  await fetchServerWsToken(url);
  store.set('remoteBackend', { kind: 'server', url });
  broadcastStore();
  restartAfterRemoteBackendChange();
});

main.ipc.handle('server:get-ws-token', async () => {
  const backend = store.get('remoteBackend');
  if (backend?.kind !== 'server') {
    throw new Error('Not connected to a self-hosted server');
  }
  return fetchServerWsToken(backend.url);
});

//#endregion

//#region GitHub account linking (OAuth device flow → github.com credential)

// Stable credential id for the OAuth-linked github.com token, so link / unlink /
// clone-time injection all reference the same SecretStore slot.
const GITHUB_CRED_ID = 'github-oauth';
const githubFetch = ((input, init) => net.fetch(input as string, init)) as typeof globalThis.fetch;

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
