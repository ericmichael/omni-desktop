import { readFileSync } from 'fs';
import { createPgListener, createPgPool, migrateFromJson, PgProjectsRepo, runPgMigrations } from 'omni-projects-db';
import type { IProjectsRepo, PgPool, ProjectsRepo } from 'omni-projects-db';
import { join } from 'path';

import { type BrowserContext, buildBrowserContext, registerBrowserHandlers } from '@/main/browser-manager';
import { createConsoleManager } from '@/main/console-manager';
import { PROJECT_KEYS } from '@/main/db-store-bridge';
import { ExtensionManager, registerExtensionHandlers } from '@/main/extension-manager';
import { registerInboxHandlers } from '@/main/inbox-handlers';
import { ACI_DESKTOP_PROFILE_NAME, ACI_PROFILE_NAME, writeAciProfile } from '@/main/aci-profile';
import { syncMcpConfig, syncMcpConfigHttp } from '@/main/mcp-config-manager';
import { MCP_PROJECTS_PATH } from '@/server/mcp-http';
import { registerMigrationHandlers } from '@/main/migration-handlers';
import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { registerPageHandlers } from '@/main/page-handlers';
import { migrateLegacyPagesToConfigDir } from '@/main/pages-relocation-migration';
import { PlatformClient } from '@/main/platform-client';
import { createPlatformClient, isEnterpriseBuild, PLATFORM_URL } from '@/main/platform-mode';
import { ProcessManager, registerProcessHandlers } from '@/main/process-manager';
import { registerProjectHandlers } from '@/main/project-handlers';
import { backfillProjectConfigs } from '@/main/project-config-backfill';
import { closeProjectDb, getDb, openProjectDb } from '@/main/project-db';
import { ProjectManager } from '@/main/project-manager';
import { registerSupervisorHandlers } from '@/main/supervisor-handlers';
import { getOmniConfigDir } from '@/main/util';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { ServerIpcAdapter } from '@/server/ipc-adapter';
import { PgSettingsStore } from '@/server/pg-settings-store';
import { resolveRuntimeTokenSecret, signRuntimeToken } from '@/server/runtime-token';
import type { ServerStore } from '@/server/store';
import { DEFAULT_TENANT } from '@/server/ws-handler';
import type { HandlerContext, WsHandler } from '@/server/ws-handler';
import { registerConfigHandlers, registerSkillsHandlers, registerUtilHandlers } from '@/shared/ipc-handlers';
import type { IpcRendererEvents, Project, StoreData } from '@/shared/types';
import { firstSource } from '@/shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type SendToWindow = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
type HandleFn = (
  channel: string,
  handler: (ctx: HandlerContext, ...args: unknown[]) => unknown | Promise<unknown>
) => void;

/**
 * Wire up global (shared) IPC handlers — store, util, config, project, process, main-process.
 * These are stateless or shared, safe for all clients to use.
 *
 * ProcessManager is global so that containers/processes survive WebSocket
 * reconnections and React re-renders. Each WS session reattaching to the same server
 * gets the existing running container status instead of spawning duplicates.
 */
export const wireGlobalHandlers = async (arg: { wsHandler: WsHandler; store: ServerStore }) => {
  const { wsHandler, store } = arg;
  // Ctx-aware registration: shared handlers receive the per-invoke
  // HandlerContext (tenant + session) in the Electron `event` slot, so they
  // can scope writes and route `store:changed` back to only the caller's
  // tenant. Handlers that ignore the event (`_`) are unaffected.
  const ipc = new ServerIpcAdapter(wsHandler.handleCtx.bind(wsHandler));

  // Project manager — shared across all clients so machines/sandboxes survive reconnections
  const sendToAll: typeof wsHandler.sendToAll = wsHandler.sendToAll.bind(wsHandler);

  // Data backend selection:
  //   - OMNI_DATABASE_URL set → Postgres (multi-tenant cloud). PgProjectsRepo
  //     is tenant-scoped + RLS-backed. The server currently runs single-tenant
  //     (DEFAULT_TENANT); per-tenant multiplexing (one ProjectManager per
  //     tenant) is the next increment.
  //   - else → the shared local SQLite file (mirrors Electron). `syncRepo`
  //     drives the change-watcher and the one-time JSON/pages migrations.
  const dbUrl = process.env['OMNI_DATABASE_URL'];
  let asyncRepo: IProjectsRepo;
  let syncRepo: ProjectsRepo | undefined;
  let pgPool: PgPool | undefined;

  if (dbUrl) {
    pgPool = createPgPool(dbUrl);
    await runPgMigrations(pgPool);
    asyncRepo = new PgProjectsRepo(pgPool, DEFAULT_TENANT);
    console.log(`[ProjectDb] Using Postgres backend (tenant: ${DEFAULT_TENANT})`);
  } else {
    // Both this server and any agent-spawned MCP stdio subprocesses read/write
    // the same projects.db via WAL.
    const opened = openProjectDb();
    syncRepo = opened.repo;
    asyncRepo = opened.asyncRepo;

    try {
      const migrated = migrateFromJson(syncRepo, getDb(), {
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

    try {
      const backfilled = backfillProjectConfigs(syncRepo);
      if (backfilled > 0) {
        console.log(`[ProjectDb] Backfilled config for ${backfilled} projects`);
      }
    } catch (err) {
      console.error('[ProjectDb] Failed to backfill project configs:', err);
    }

    try {
      const summary = migrateLegacyPagesToConfigDir(syncRepo);
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
  }

  try {
    if (dbUrl) {
      // Cloud (Postgres): the agent reaches project data over the network via
      // the launcher server's own loopback MCP route (omni serve runs in this
      // same container). Per-tenant auth comes from OMNI_RUNTIME_TOKEN in the
      // omni-serve env (injected below), expanded into the entry's header.
      const port = process.env['PORT'] ?? '3001';
      syncMcpConfigHttp(`http://127.0.0.1:${port}${MCP_PROJECTS_PATH}`);
    } else {
      // Local/desktop: stdio MCP over the local SQLite DB.
      syncMcpConfig();
    }
  } catch (err) {
    console.error('[mcp-config] failed to sync:', err);
  }

  // When Azure is configured, write the `aci` sandbox profile so `omni serve
  // --profile aci` drives the serverless ACI sandbox. When present, the cloud
  // Restricts the picker to the ACI profiles (host/devbox disabled) — see
  // getStoreSnapshot + the ProcessManager allowedProfileNames below.
  let aciConfigured = false;
  try {
    const aciProfilePath = writeAciProfile(getOmniConfigDir());
    aciConfigured = aciProfilePath !== null;
    if (aciProfilePath) {
      console.log(`[aci] wrote sandbox profile to ${aciProfilePath}`);
    }
  } catch (err) {
    console.error('[aci] failed to write sandbox profile:', err);
  }

  // --- Per-tenant manager registry ---
  //
  // Each tenant gets its own ProjectManager (in-memory projection over a
  // tenant-scoped repo) and ProcessManager, created lazily. Their sendToWindow
  // routes to ONLY that tenant's WS connections via sendToTenant, so store
  // snapshots and agent-process output never cross tenants — this closes the
  // Phase-1 broadcast-leak deferral. SQLite mode is single-tenant: with no
  // EasyAuth every connection is DEFAULT_TENANT, so the map holds one entry
  // sharing the one SQLite repo + change-watcher.
  ProjectManager.migrateToSupervisor(store as any);

  // This replica's id — tagged onto Postgres change-notifications so we ignore
  // our own writes and re-hydrate only on writes from other replicas / the MCP.
  const replicaId = crypto.randomUUID();

  // Azure sandboxing is host-runs-agent: `omni serve` runs here and drives a
  // serverless ACI container via the `aci` sandbox profile (omniagents
  // AzureContainerSandbox) — selected through the agent's profile, NOT a
  // platform client. So there's no Azure compute client here; `platformClient`
  // stays the omni-platform delegation path for enterprise-platform builds.

  // Secret for signing/verifying the runtime tokens the agent uses to call back
  // into the tenant-scoped HTTP MCP route (minted into the omni-serve env at
  // agent launch; verified by the route).
  const runtimeTokenSecret = resolveRuntimeTokenSecret();

  /** Per-tenant settings store: Postgres-backed in cloud, the shared JSON store locally. */
  type SettingsStore = ServerStore | PgSettingsStore;
  type TenantInstance = {
    projectManager: ProjectManager;
    processManager: ProcessManager;
    settings: SettingsStore;
    extension: ExtensionManager;
    browser: BrowserContext;
    configDir: string;
  };
  const tenants = new Map<string, TenantInstance>();

  const createTenant = (tenantId: string): TenantInstance => {
    // Postgres: a per-tenant user_settings row (RLS-isolated). SQLite/local:
    // the single shared ServerStore (one tenant only).
    const settings: SettingsStore = pgPool ? new PgSettingsStore(pgPool, tenantId, replicaId) : store;
    // Per-tenant config dir (skills live under <configDir>/skills). Postgres
    // mode isolates per tenant; local/SQLite keeps the shared config dir.
    const configDir = pgPool ? join(getOmniConfigDir(), 'tenants', tenantId) : getOmniConfigDir();
    const tenantSend: SendToWindow = (channel, ...args) => wsHandler.sendToTenant(tenantId, channel, ...args);
    let ref: TenantInstance | undefined;
    const processManager = new ProcessManager({
      sendToWindow: tenantSend,
      fetchFn: globalThis.fetch,
      getStoreData: () => ({
        defaultProfileName: settings.get('defaultProfileName') ?? 'host',
        projects: ref?.projectManager.getStoreSnapshot().projects ?? [],
      }),
      // Cloud: mint a fresh per-tenant runtime token for each omni-serve spawn,
      // so the agent's HTTP MCP calls resolve to THIS tenant's data. The route
      // verifies it; an untrusted sandbox can't forge another tenant.
      getExtraEnv: dbUrl
        ? () => ({
            OMNI_RUNTIME_TOKEN: signRuntimeToken(runtimeTokenSecret, {
              tenantId,
              sessionId: crypto.randomUUID(),
            }),
          })
        : undefined,
      // Cloud with Azure → agents run in a serverless ACI sandbox; host/devbox
      // are not selectable, but the user picks between the fast and desktop
      // ACI profiles.
      allowedProfileNames: aciConfigured ? [ACI_PROFILE_NAME, ACI_DESKTOP_PROFILE_NAME] : undefined,
    });
    // Keep this tenant's platform client in sync with its own credentials.
    // (omni-platform delegation for enterprise-platform builds; the ACI sandbox
    // path does not use a platform client — see note above.)
    const applyPlatformClient = (): void => {
      processManager.platformClient = createPlatformClient(settings.get('platform'), globalThis.fetch);
    };
    applyPlatformClient();
    settings.onDidAnyChange(() => applyPlatformClient());
    const projectManager = new ProjectManager({
      store: settings as any,
      sendToWindow: tenantSend,
      processManager,
      // Postgres: a tenant-scoped PgProjectsRepo (RLS-isolated). SQLite: the
      // single shared repo + sync change-watcher (one tenant only).
      repo: pgPool ? new PgProjectsRepo(pgPool, tenantId, replicaId) : asyncRepo,
      changeSeqRepo: pgPool ? undefined : syncRepo,
      skillsDir: join(configDir, 'skills'),
    });
    // Per-tenant extensions + browser, backed by the same tenant settings store
    // (enabledExtensions / browser profiles/tabs/history/bookmarks are per-user).
    const extension = new ExtensionManager({ store: settings as any, sendToWindow: tenantSend });
    const browser = buildBrowserContext(settings as any, tenantSend);
    ref = { projectManager, processManager, settings, extension, browser, configDir };
    tenants.set(tenantId, ref);
    return ref;
  };

  const getTenant = (tenantId: string): TenantInstance => tenants.get(tenantId) ?? createTenant(tenantId);
  const getProcessManager = (tenantId: string): ProcessManager => getTenant(tenantId).processManager;
  const getSettings = (tenantId: string): SettingsStore => getTenant(tenantId).settings;
  /**
   * Create (if needed) and fully hydrate a tenant's settings + projection. The
   * server awaits this on WS connect BEFORE processing any of the connection's
   * messages, so a write never races a late hydrate that would clobber either
   * cache. Settings hydrate first so the projection's init reads real prefs.
   */
  const ensureTenantReady = async (tenantId: string): Promise<void> => {
    const t = getTenant(tenantId);
    if (t.settings instanceof PgSettingsStore) {
      await t.settings.whenReady;
    }
    await t.projectManager.whenReady;
  };
  const getStoreSnapshot = (tenantId: string): StoreData => {
    const snapshot = getTenant(tenantId).projectManager.getStoreSnapshot();
    // Cloud/ACI: force the picker to `aci` only and make it the selected
    // default. Computed (not persisted) so it tracks the deployment, not a
    // stale per-tenant setting. Matches the ProcessManager allowedProfileNames.
    if (aciConfigured) {
      return {
        ...snapshot,
        defaultProfileName: snapshot.defaultProfileName === ACI_DESKTOP_PROFILE_NAME
          ? ACI_DESKTOP_PROFILE_NAME
          : ACI_PROFILE_NAME,
        availableSandboxProfiles: [ACI_PROFILE_NAME, ACI_DESKTOP_PROFILE_NAME],
      };
    }
    return snapshot;
  };
  /**
   * A tenant-scoped repo for the HTTP MCP route. Postgres: a fresh
   * tenant-scoped PgProjectsRepo (RLS isolates it). SQLite: the single shared
   * repo (one tenant only). Writes flow through this repo, so the LISTEN/NOTIFY
   * (Postgres) and change-watcher (SQLite) layers keep ProjectManager caches
   * coherent automatically — the same path used by the launcher's own writes.
   */
  const getTenantRepo = (tenantId: string): IProjectsRepo =>
    pgPool ? new PgProjectsRepo(pgPool, tenantId, replicaId) : asyncRepo;
  /** Resolve the caller's tenant ProjectManager from the per-invoke HandlerContext. */
  const tenantPM = (event: unknown): ProjectManager => getTenant((event as HandlerContext).tenantId).projectManager;

  // --- Global managers (shared across tenants) ---
  const [omniInstall, cleanupOmniInstall] = createOmniInstallManager({
    ipc,
    sendToWindow: sendToAll,
  });

  // Per-tenant handlers — registered ONCE; the resolver picks the caller's
  // tenant from the HandlerContext at invoke time.
  registerProjectHandlers(ipc, tenantPM);
  registerSupervisorHandlers(ipc, (e) => tenantPM(e).supervisors);
  registerMilestoneHandlers(ipc, (e) => tenantPM(e).milestones);
  registerPageHandlers(ipc, (e) => tenantPM(e).pages, (e, projectId) => tenantPM(e).getProjectDir(projectId));
  registerInboxHandlers(ipc, (e) => tenantPM(e).inbox);
  registerProcessHandlers(ipc, (e) => getTenant((e as HandlerContext).tenantId).processManager);
  registerExtensionHandlers(ipc, (e) => getTenant((e as HandlerContext).tenantId).extension);
  registerBrowserHandlers(ipc, (e) => getTenant((e as HandlerContext).tenantId).browser);

  // Eagerly create + hydrate the default tenant so its cache is warm before the
  // server serves requests (matters for Postgres, where hydration is real I/O).
  // SQLite mode only ever has this tenant. NOTE: other tenants are created
  // lazily and their initial hydration is not awaited per-request yet — fine
  // for brand-new tenants (empty cache is correct); cold-loading an existing
  // tenant's data on a fresh replica is a follow-up (await readiness in dispatch).
  const defaultTenant = getTenant(DEFAULT_TENANT);
  // Bridge handlers: register once on any bridge with a tenant resolver.
  defaultTenant.projectManager.bridge.registerIpc(ipc, (e) => tenantPM(e).bridge);
  await defaultTenant.projectManager.whenReady;

  // Multi-replica cache coherence: LISTEN for Postgres change notifications and
  // re-hydrate the affected tenant's projection + settings — but only for
  // FOREIGN writes (other replicas / the MCP subprocess), since our own writes
  // already updated the cache. Notifications are debounced per tenant so a
  // burst collapses into one re-hydrate.
  let stopListener: (() => Promise<void>) | undefined;
  if (pgPool && dbUrl) {
    const pendingRefresh = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const flushRefresh = () => {
      refreshTimer = undefined;
      const ids = [...pendingRefresh];
      pendingRefresh.clear();
      for (const tid of ids) {
        const t = tenants.get(tid);
        if (!t) {
          continue;
        }
        void t.projectManager.refreshFromExternal();
        if (t.settings instanceof PgSettingsStore) {
          void t.settings.reload().then(() => wsHandler.sendToTenant(tid, 'store:changed', getStoreSnapshot(tid)));
        }
      }
    };
    stopListener = await createPgListener(dbUrl, 'omni_change', (payload) => {
      try {
        const { t, o, p } = JSON.parse(payload) as { t?: string; o?: string; p?: string };
        if (!t || !tenants.has(t)) {
          return; // missing tenant, or a tenant we don't host
        }
        if (p) {
          // Page-content change → push the new body to this tenant's editors.
          // Emit unconditionally (no origin skip); the renderer ignores an echo
          // that matches its buffer.
          void new PgProjectsRepo(pgPool!, t)
            .getPageContent(p)
            .then((body) => wsHandler.sendToTenant(t, 'page:content-changed', p, body ?? ''))
            .catch(() => {});
          return;
        }
        if (o === replicaId) {
          return; // our own projection write — cache is already current
        }
        pendingRefresh.add(t);
        if (!refreshTimer) {
          refreshTimer = setTimeout(flushRefresh, 50);
        }
      } catch {
        // ignore malformed payloads
      }
    });
    console.log(`[ProjectDb] Listening for cross-replica changes (replica ${replicaId})`);
  }

  // Background workspace sync — keeps project workspaces synced to Azure
  // Files so cloud sessions could mount the share instantly without tar
  // upload. After the v22 cut the sync manager is no longer wired through
  // ProcessManager (Shape B handles workspace materialization via
  // SandboxClient/Manifest); the IPC channels survive so the SyncBar UI
  // can still report status for any projects that opted in.
  const OMNI_CONFIG_DIR = getOmniConfigDir();
  const syncManager = new WorkspaceSyncManager({
    fetchFn: globalThis.fetch,
    manifestDir: OMNI_CONFIG_DIR,
    onStatusChange: (projectId, status) => {
      wsHandler.sendToAll('workspace-sync:status-changed', projectId, status);
    },
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

  // Each tenant's ProcessManager platform client is managed inside createTenant
  // (keyed to that tenant's own credentials). The global workspace-sync manager
  // uses the default tenant's platform client.
  const updateSyncPlatformClient = () => {
    syncManager.setPlatformClient(createPlatformClient(getSettings(DEFAULT_TENANT).get('platform'), globalThis.fetch));
  };
  updateSyncPlatformClient();
  const unsubPlatform = getSettings(DEFAULT_TENANT).onDidAnyChange(() => updateSyncPlatformClient());

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
    const profileName = store.get('defaultProfileName') ?? 'host';
    // Only sync when the platform profile is active
    if (profileName !== 'platform') {
      return;
    }

    for (const project of projects) {
      const s = firstSource(project);
      if (s?.kind === 'local' && s.workspaceDir) {
        syncManager.startSync(project.id, s.workspaceDir).catch((e) => {
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

  // Store handlers — snapshot-aware: project keys come from the SQL projection;
  // every other (settings) key reads/writes the caller's per-tenant store.
  ipc.handle('store:get-key', (ctx, key) => {
    const k = key as keyof import('@/shared/types').StoreData;
    if (PROJECT_KEYS.has(k)) {
      return getStoreSnapshot(ctx.tenantId)[k];
    }
    return getSettings(ctx.tenantId).get(k);
  });
  ipc.handle('store:set-key', (ctx, key, value) => {
    const k = key as keyof import('@/shared/types').StoreData;
    if (PROJECT_KEYS.has(k)) {
      throw new Error(
        `store:set-key for project key "${String(k)}" is not allowed when SQLite is active. Use ProjectManager APIs.`
      );
    }
    getSettings(ctx.tenantId).set(k, value as never);
    wsHandler.sendToTenant(ctx.tenantId, 'store:changed', getStoreSnapshot(ctx.tenantId));
  });
  ipc.handle('store:get', (ctx) => getStoreSnapshot(ctx.tenantId));
  ipc.handle('store:set', (ctx, data) => {
    const conflicts = [...PROJECT_KEYS].filter((k) => k in data);
    if (conflicts.length > 0) {
      throw new Error(`store:set with project keys [${conflicts.join(', ')}] is not allowed when SQLite is active.`);
    }
    getSettings(ctx.tenantId).store = data;
    wsHandler.sendToTenant(ctx.tenantId, 'store:changed', getStoreSnapshot(ctx.tenantId));
  });
  ipc.handle('store:reset', (ctx) => {
    getSettings(ctx.tenantId).clear();
    wsHandler.sendToTenant(ctx.tenantId, 'store:changed', getStoreSnapshot(ctx.tenantId));
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
  registerSkillsHandlers(
    ipc,
    (e) => getTenant((e as HandlerContext).tenantId).configDir,
    (e) => getSettings((e as HandlerContext).tenantId) as never
  );
  registerMigrationHandlers(ipc, (e) => {
    const tenantId = (e as HandlerContext).tenantId;
    const settings = getSettings(tenantId);
    return {
      get: () => settings.get('pagesMigration') ?? null,
      set: (value) => {
        if (value === null) {
          settings.delete('pagesMigration');
        } else {
          settings.set('pagesMigration', value);
        }
        wsHandler.sendToTenant(tenantId, 'store:changed', getStoreSnapshot(tenantId));
      },
    };
  });

  // Desktop-only handlers — stubbed for browser mode
  ipc.handle('util:select-directory', () => null);
  ipc.handle('util:select-file', () => null);
  ipc.handle('util:open-directory', () => '');
  ipc.handle('util:open-external', () => {});

  // Platform handlers

  /** Fetch policy (touches token refresh) against a tenant's own credentials. */
  const fetchAndApplyPolicy = async (
    credentials: { accessToken: string; refreshToken: string },
    settings: SettingsStore
  ) => {
    try {
      const client = new PlatformClient(
        { url: PLATFORM_URL, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
        globalThis.fetch
      );
      client.onTokenRefresh = (newToken) => {
        const current = settings.get('platform');
        if (current) {
          settings.set('platform', { ...current, accessToken: newToken });
        }
      };
      // v22: platform-pushed sandbox profiles are no longer materialized into
      // the launcher store (step 6 turns the platform path into a
      // SandboxClient; until then the `platform` profile name is selected
      // through the same defaultProfileName setting as every other profile).
      // We still touch the policy endpoint so token refresh stays current.
      await client.getPolicy('omni_code');
      autoStartSync();
    } catch (e) {
      console.warn('[Platform] Failed to fetch policy:', (e as Error).message);
    }
  };

  ipc.handle('platform:is-enterprise', () => isEnterpriseBuild());
  ipc.handle('platform:get-auth', (ctx) => getSettings(ctx.tenantId).get('platform') ?? null);
  ipc.handle('platform:sign-in', async (ctx) => {
    if (!isEnterpriseBuild()) {
      throw new Error('Not an enterprise build');
    }
    // Capture the acting tenant's settings so the detached poll writes the
    // credentials to that tenant only and notifies just its sessions.
    const tenantId = ctx.tenantId;
    const settings = getSettings(tenantId);
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
            settings.set('platform', credentials);
            wsHandler.sendToTenant(tenantId, 'platform:auth-changed', credentials);
            await fetchAndApplyPolicy(credentials, settings);
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
  ipc.handle('platform:sign-out', (ctx) => {
    const settings = getSettings(ctx.tenantId);
    settings.delete('platform');
    settings.set('defaultProfileName', 'host');
    wsHandler.sendToTenant(ctx.tenantId, 'platform:auth-changed', null);
  });

  // Refresh policy on startup if the default tenant is already signed in.
  const existingCreds = getSettings(DEFAULT_TENANT).get('platform');
  if (existingCreds?.accessToken && isEnterpriseBuild()) {
    void fetchAndApplyPolicy(existingCreds, getSettings(DEFAULT_TENANT));
  }

  ipc.handle('platform:get-dashboards', async (ctx) => {
    const settings = getSettings(ctx.tenantId);
    const creds = settings.get('platform');
    if (!creds?.accessToken || !isEnterpriseBuild()) {
      return [];
    }

    try {
      const client = new PlatformClient(
        {
          url: PLATFORM_URL,
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken ?? '',
        },
        globalThis.fetch
      );

      client.onTokenRefresh = (newToken) => {
        const current = settings.get('platform');
        if (current) {
          settings.set('platform', { ...current, accessToken: newToken });
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
    if (stopListener) {
      await stopListener();
    }
    const tenantCleanups = [...tenants.values()].flatMap((t) => [
      t.projectManager.exit(),
      t.processManager.cleanup(),
      t.extension.cleanup(),
      t.settings instanceof PgSettingsStore ? t.settings.flush() : Promise.resolve(),
    ]);
    const results = await Promise.allSettled([
      syncManager.dispose(),
      cleanupOmniInstall(),
      ...tenantCleanups,
    ]);
    closeProjectDb();
    if (pgPool) {
      await pgPool.end();
    }
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up global managers:', errors);
    }
  };

  return { cleanupGlobalManagers, getProcessManager, ensureTenantReady, getTenantRepo, runtimeTokenSecret };
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
  processManager: ProcessManager;
}): (() => Promise<void>) => {
  const { handle, sendToWindow, processManager } = arg;
  const ipc = new ServerIpcAdapter(handle);

  // Console proxies terminal:* IPC through omni serve's WS so the shell
  // runs inside the sandbox. Per-session so output routes to the right
  // WebSocket client; the underlying PTYs live in `omni serve` and survive
  // a WS reconnect (the renderer can reissue terminal:create on a fresh
  // process).
  const [, cleanupConsole] = createConsoleManager({
    ipc,
    sendToWindow,
    processManager,
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
