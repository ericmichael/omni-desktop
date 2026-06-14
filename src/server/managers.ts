import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { IProjectsRepo, PgPool, ProjectsRepo } from 'omni-projects-db';
import {
  ControlPlaneRepo,
  createPgListener,
  createPgPool,
  loadLegacyUserSettings,
  MachinesRepo,
  migrateFromJson,
  PgProjectsRepo,
  runPgMigrations,
  saveTeamSettings,
  saveUserSettings,
} from 'omni-projects-db';
import { join } from 'path';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig, parseEnvVars } from '@/lib/agent-config';
import { uuidv4 } from '@/lib/uuid';
import { ACI_DESKTOP_PROFILE_NAME, ACI_PROFILE_NAME, writeAciProfile } from '@/main/aci-profile';
import { listRepos as azureListRepos } from '@/main/azure-repos';
import { type BrowserContext, buildBrowserContext, registerBrowserHandlers } from '@/main/browser-manager';
import {
  type CodexTokens,
  ensureFreshTokens as codexEnsureFresh,
  getStatus as codexStatus,
  loginWithDeviceFlow as codexDeviceLogin,
  logout as codexLogout,
} from '@/main/codex-auth';
import { migrateAgentConfigFromFiles } from '@/main/config-files-migration';
import { collectSecretEnv, materializeAgentConfig } from '@/main/config-materializer';
import { createConsoleManager } from '@/main/console-manager';
import { PROJECT_KEYS } from '@/main/db-store-bridge';
import { ExtensionManager, registerExtensionHandlers } from '@/main/extension-manager';
import {
  linkWithDeviceFlow as githubLink,
  listOrgs as githubListOrgs,
  searchRepos as githubSearchRepos,
} from '@/main/github-auth';
import { registerInboxHandlers } from '@/main/inbox-handlers';
import { getMcpBinPath } from '@/main/mcp-config-manager';
import { registerMigrationHandlers } from '@/main/migration-handlers';
import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { registerPageHandlers } from '@/main/page-handlers';
import { migrateLegacyPagesToConfigDir } from '@/main/pages-relocation-migration';
import { PlatformClient } from '@/main/platform-client';
import { createPlatformClient, isEnterpriseBuild, PLATFORM_URL } from '@/main/platform-mode';
import { ProcessManager, registerProcessHandlers } from '@/main/process-manager';
import { backfillProjectConfigs } from '@/main/project-config-backfill';
import { closeProjectDb, getDb, openProjectDb } from '@/main/project-db';
import { registerProjectHandlers } from '@/main/project-handlers';
import { ProjectManager } from '@/main/project-manager';
import { registerSnapshotHandlers } from '@/main/snapshot-manager';
import { registerSupervisorHandlers } from '@/main/supervisor-handlers';
import { getOmniConfigDir } from '@/main/util';
import { WorkspaceSyncManager } from '@/main/workspace-sync-manager';
import { requireRole } from '@/server/authz';
import { AzureFilesArtifactStore } from '@/server/azure-artifact-store';
import { CODEX_REFRESH_PATH } from '@/server/codex-refresh-http';
import { CompositeSettingsStore } from '@/server/composite-settings-store';
import { HostBridgePreparer } from '@/server/host-bridge-preparer';
import { ServerIpcAdapter } from '@/server/ipc-adapter';
import { MachineRegistry } from '@/server/machine-registry';
import { MCP_PROJECTS_PATH } from '@/server/mcp-http';
import { assertNonBypassingRole, ensureAppRole, ensureSessionsDb, grantAppPrivileges } from '@/server/pg-bootstrap';
import { PgSecretStore } from '@/server/pg-secret-store';
import { resolveRuntimeTokenSecret, signRuntimeToken } from '@/server/runtime-token';
import { ServerSecretStore } from '@/server/secret-store';
import type { ServerStore } from '@/server/store';
import { registerTeamHandlers } from '@/server/team-handlers';
import type { HandlerContext, WsHandler } from '@/server/ws-handler';
import { DEFAULT_TENANT } from '@/server/ws-handler';
import { tokenLast4 } from '@/shared/git-credentials';
import {
  registerConfigHandlers,
  registerGitCredentialHandlers,
  registerSettingsConfigHandlers,
  registerSkillsHandlers,
  registerUtilHandlers,
  type SettingsConfigStore,
} from '@/shared/ipc-handlers';
import { buildHttpMcpEntry, buildStdioMcpEntry } from '@/shared/mcp-entry';
import { maskMcpConfig, maskModelsConfig, restoreMaskedModels } from '@/shared/secret-mask';
import { classify } from '@/shared/settings-layers';
import type {
  GitCredential,
  GithubOwner,
  GithubRepoQuery,
  GithubStatus,
  IpcRendererEvents,
  Project,
  RemoteRepo,
  StoreData,
} from '@/shared/types';
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
export const wireGlobalHandlers = async (arg: {
  wsHandler: WsHandler;
  store: ServerStore;
  /** Optional override — pass when the caller (server/index.ts) needs the
   *  same secret for /api/ws-token signing. Falls back to env resolution. */
  runtimeTokenSecret?: string;
}) => {
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
  // Admin DSN, set only in the managed/cloud deployment. When present, the
  // server bootstraps the non-superuser `omni_app` role + runs migrations as
  // the admin owner, then serves traffic via the (RLS-enforced) omni_app pool.
  const dbAdminUrl = process.env['OMNI_DATABASE_ADMIN_URL'];
  let asyncRepo: IProjectsRepo;
  let syncRepo: ProjectsRepo | undefined;
  let pgPool: PgPool | undefined;
  // Persistent admin pool (cloud only) — owns the schema; used for migrations
  // and the teams control plane (which must bypass the dormant control-plane RLS).
  let pgAdminPool: PgPool | undefined;

  if (dbUrl) {
    pgPool = createPgPool(dbUrl);
    if (dbAdminUrl) {
      // Least-privilege posture: provision omni_app + run migrations as admin
      // (owner), so RLS is enforced on the omni_app pool below.
      await ensureAppRole(dbAdminUrl, dbUrl);
      pgAdminPool = createPgPool(dbAdminUrl);
      await runPgMigrations(pgAdminPool);
      await grantAppPrivileges(dbAdminUrl);
      // Fail-closed: never serve multi-tenant traffic on a role that bypasses RLS.
      await assertNonBypassingRole(pgPool);
    } else {
      // Self-hosted single-tenant: the configured role owns the schema and runs
      // migrations directly (no separate admin URL, no RLS-bypass guard).
      await runPgMigrations(pgPool);
    }
    asyncRepo = new PgProjectsRepo(pgPool, DEFAULT_TENANT);
    console.log(`[ProjectDb] Using Postgres backend`);

    // omniagents session-history DB lives in a sibling logical database on the
    // same PG server. Grant the omni_app role CREATE on its public schema so
    // omniagents' PgSessionStorage can install its own schema on first use.
    // No-op when OMNIAGENTS_HISTORY_ADMIN_URL isn't set (self-hosted single
    // tenant deployments that don't use the cloud sessions DB).
    const sessionsAdminUrl = process.env['OMNIAGENTS_HISTORY_ADMIN_URL'];
    if (sessionsAdminUrl) {
      try {
        await ensureSessionsDb(sessionsAdminUrl);
        console.log('[Sessions] bootstrapped omni_sessions schema grants');
      } catch (err) {
        console.error('[Sessions] failed to bootstrap omni_sessions DB:', err);
      }
    }
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

  // The managed `omni-projects` MCP entry is no longer written globally here —
  // it's merged per-tenant by materializeTenant() (below), so each tenant's
  // mcp.json carries the right transport: the loopback HTTP route in cloud
  // (auth via the per-tenant OMNI_RUNTIME_TOKEN), or the bundled stdio cli
  // over the shared SQLite DB locally.
  const port = process.env['PORT'] ?? '3001';

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
  const replicaId = uuidv4();

  // Azure sandboxing is host-runs-agent: `omni serve` runs here and drives a
  // serverless ACI container via the `aci` sandbox profile (omniagents
  // AzureContainerSandbox) — selected through the agent's profile, NOT a
  // platform client. So there's no Azure compute client here; `platformClient`
  // stays the omni-platform delegation path for enterprise-platform builds.

  // Secret for signing/verifying the runtime tokens the agent uses to call back
  // into the tenant-scoped HTTP MCP route (minted into the omni-serve env at
  // agent launch; verified by the route). Use the caller-provided value when
  // present so server/index.ts (which signs /api/ws-token tokens with the same
  // secret) and this module are guaranteed to agree.
  const runtimeTokenSecret = arg.runtimeTokenSecret ?? resolveRuntimeTokenSecret();

  // Git tokens. Cloud (Postgres): durable, RLS-isolated PgSecretStore keyed by
  // (principal, cred). Local/Electron: the on-disk ServerSecretStore.
  const secretStore = new ServerSecretStore();
  const pgSecret = pgPool ? new PgSecretStore(pgPool) : undefined;

  // Teams control plane (cloud only) — users/teams/memberships/invitations.
  // Accessed via the admin pool (or the PG owner self-hosted), which bypasses
  // the dormant control-plane RLS; isolation is app-level (scoped by principal).
  const controlPlanePool = pgAdminPool ?? pgPool;
  const controlPlane = controlPlanePool ? new ControlPlaneRepo(controlPlanePool) : undefined;
  // Per-principal machines registry — Electrons that registered as
  // computer-as-sandbox compute targets. Same admin-pool model as the
  // control plane.
  const machinesRepo = controlPlanePool ? new MachinesRepo(controlPlanePool) : undefined;
  // Sync cache of `local:<machineId>` picker entries per principal, fed by
  // `broadcastMachines` (which has the async summaries) and read sync by
  // `getStoreSnapshot`. The single per-tenant `HostBridgePreparer` handles all
  // machines, so there is no per-machine client map to maintain.
  const localMachineIdsByPrincipal = new Map<string, string[]>();
  // Push a fresh machine summary list to every session of *principal* whenever
  // anything changes (bind, release, rename, remove). Hoisted so the registry
  // can call into it without knowing about WsHandler. Also nudges the store
  // snapshot so the sandbox picker reflects the new machine immediately.
  const broadcastMachines = async (principal: string): Promise<void> => {
    if (!machineRegistry) {
      return;
    }
    try {
      const summaries = await machineRegistry.listForPrincipal(principal);
      // Renderer cares about *its* view; isSelf is recomputed there since the
      // caller machineId depends on which Electron is listening.
      wsHandler.sendToPrincipalInTeam(principal, principal, 'machine:list-changed', summaries);
      localMachineIdsByPrincipal.set(
        principal,
        summaries.map((m) => m.machineId)
      );
      // Replay store snapshot so availableSandboxProfiles + picker refresh.
      // Iterate every tenant instance for the principal (across teams).
      for (const [key] of tenants) {
        if (!key.endsWith(`::${principal}`) && key !== principal) {
          continue;
        }
        const sep = key.indexOf('::');
        const teamId = sep >= 0 ? key.slice(0, sep) : key;
        sendSnapshot(teamId, principal);
      }
    } catch (err) {
      console.error('[machines] broadcastMachines failed:', err);
    }
  };
  /**
   * Adoption flow (Phase 6). When a machine reconnects, ask the laptop's
   * Electron which of its previously-anchored sessions are still running.
   * For each adopted session, push a fresh `agent-process:status`
   * `running` envelope so the renderer flips out of the host-offline
   * banner without restarting omni-serve. For sessions the laptop no
   * longer knows about, push an error so the renderer can prompt restart.
   */
  const adoptSessionsOnReconnect = async (machineId: string, principal: string): Promise<void> => {
    if (!machineRegistry) {
      return;
    }
    // host_bridge model: the agent runs in the CLOUD (it survived the laptop's
    // disconnect) — only the sandbox exec channel to the laptop broke. On
    // reconnect, rebuild each local session anchored to this machine so the
    // channel is re-established (fresh `omni sandbox-host` + `omni serve` with a
    // new host_bridge profile). Chat history survives (PgSessionStorage) and the
    // workspace lives on the laptop's disk, so it's a clean resume. The cloud's
    // per-tenant ProcessManager is the source of truth for which sessions are on
    // this machine (the registry's anchors are dropped while a machine is
    // offline; the ProcessManager's map persists).
    for (const [key, t] of tenants) {
      if (!key.endsWith(`::${principal}`) && key !== principal) {
        continue;
      }
      try {
        await t.processManager.resumeOnReconnect(machineId);
      } catch (err) {
        console.error(`[host-bridge] resumeOnReconnect failed for ${machineId}:`, (err as Error).message);
      }
    }
  };

  // Push a host-offline overlay to every local session on a machine that just
  // went offline (its laptop WS dropped). The agent keeps running in the cloud;
  // this only flips the renderer banner. Iterates the principal's tenant(s).
  const broadcastHostOfflineForPrincipal = (machineId: string, principal: string): void => {
    for (const [key, t] of tenants) {
      if (!key.endsWith(`::${principal}`) && key !== principal) {
        continue;
      }
      try {
        t.processManager.broadcastHostOffline(machineId);
      } catch (err) {
        console.error(`[host-bridge] broadcastHostOffline failed for ${machineId}:`, (err as Error).message);
      }
    }
  };

  const machineRegistry: MachineRegistry | undefined = machinesRepo
    ? new MachineRegistry(machinesRepo, {
        onChanged: (p) => void broadcastMachines(p),
        onMachineOnline: (mid, pid) => void adoptSessionsOnReconnect(mid, pid),
        onMachineOffline: (mid, pid) => broadcastHostOfflineForPrincipal(mid, pid),
      })
    : undefined;

  // Teams activate under easyauth multi-tenant; PG-without-easyauth is one
  // 'local' team, SQLite/Electron has no teams.
  const teamsEnabled = !!(pgPool && process.env['OMNI_AUTH_MODE'] === 'easyauth');

  /** Per-(team, principal) settings: composite (team base + user overlay) in cloud, shared JSON locally. */
  type SettingsStore = ServerStore | CompositeSettingsStore;
  type TenantInstance = {
    projectManager: ProjectManager;
    processManager: ProcessManager;
    settings: SettingsStore;
    extension: ExtensionManager;
    browser: BrowserContext;
    configDir: string;
  };
  const tenants = new Map<string, TenantInstance>();
  /** Registry key: a team's data scope is shared, but settings + broadcasts are per-principal. */
  const tenantKey = (teamId: string, principalId: string): string => `${teamId}::${principalId}`;

  const createTenant = (teamId: string, principalId: string = teamId): TenantInstance => {
    // Cloud: composite store (team_settings base ⊕ this principal's overlay).
    // SQLite/local: the single shared ServerStore (one tenant only).
    const settings: SettingsStore = pgPool ? new CompositeSettingsStore(pgPool, teamId, principalId, replicaId) : store;
    // Per-(team, principal) config dir so two members' materialized secret-free
    // configs don't collide. Local/SQLite keeps the shared config dir.
    const configDir = pgPool ? join(getOmniConfigDir(), 'tenants', teamId, 'users', principalId) : getOmniConfigDir();
    // Cloud: route this instance's broadcasts to ONLY this principal's sessions
    // (user-scoped store keys must not leak to other team members). Project-data
    // changes by other members reach this principal via the NOTIFY re-hydrate.
    // Local: broadcast to all (single user).
    const tenantSend: SendToWindow = pgPool
      ? (channel, ...args) => wsHandler.sendToPrincipalInTeam(teamId, principalId, channel, ...args)
      : (channel, ...args) => wsHandler.sendToTenant(teamId, channel, ...args);
    let ref: TenantInstance | undefined;
    const processManager = new ProcessManager({
      sendToWindow: tenantSend,
      fetchFn: globalThis.fetch,
      getStoreData: () => ({
        defaultProfileName: settings.get('defaultProfileName') ?? 'host',
        projects: ref?.projectManager.getStoreSnapshot().projects ?? [],
        gitCredentials: settings.get('gitCredentials') ?? [],
      }),
      // Cloud: git/github tokens are this principal's (U-identity), so agent
      // pushes carry their own identity. Local: the on-disk store.
      resolveGitToken: (id) => (pgSecret ? pgSecret.getUserGitToken(principalId, id) : secretStore.getGitToken(id)),
      // Cloud: mint a fresh per-(team, principal) runtime token for each
      // omni-serve spawn, so the agent's HTTP MCP calls resolve to THIS team's
      // data as THIS user. The route verifies it; a sandbox can't forge another.
      //
      // The codex-refresh callback URL is derived from the same site as the
      // existing OMNI_DATA_API_URL (data API + codex callback are co-resident).
      // Falls back to undefined when no cloud URL is configured — the Python
      // runtime treats absence of OMNI_CODEX_REFRESH_URL as "don't call back".
      getExtraEnv: dbUrl
        ? async () => {
            const codexRefreshUrl = (() => {
              const dataApi = process.env['OMNI_DATA_API_URL'];
              if (!dataApi) {
                return undefined;
              }
              try {
                const u = new URL(dataApi);
                u.pathname = CODEX_REFRESH_PATH;
                u.search = '';
                return u.toString();
              } catch {
                return undefined;
              }
            })();
            // Materialize this principal's Codex tokens into the spawn's
            // config dir (where the runtime expects to find them). PgSecretStore
            // is the durable source of truth — the launcher container's FS is
            // ephemeral on Azure. Pre-refresh near-expiry tokens here so the
            // first call from the spawn doesn't race the clock; runtime-side
            // refreshes during the spawn's lifetime aren't persisted back (the
            // refresh token itself is long-lived, so the next spawn just
            // re-materializes; if `refresh` is ever rotated to invalid, the
            // user re-signs in).
            if (pgSecret) {
              const stored = (await pgSecret.getUserCodexTokens(principalId)) as
                | (CodexTokens & Record<string, unknown>)
                | undefined;
              if (stored?.refresh) {
                try {
                  const fresh = await codexEnsureFresh(stored);
                  if (fresh !== stored) {
                    await pgSecret.setUserCodexTokens(principalId, fresh as unknown as Record<string, unknown>);
                  }
                  const codexPath = join(configDir, '.config', 'omni_code');
                  mkdirSync(codexPath, { recursive: true });
                  const tokenFile = join(codexPath, 'codex.json');
                  writeFileSync(tokenFile, `${JSON.stringify(fresh, null, 2)}\n`, 'utf-8');
                  chmodSync(tokenFile, 0o600);
                } catch (err) {
                  // Best-effort: a stale refresh token shouldn't break a
                  // non-Codex spawn. The runtime will just see no codex.json
                  // and skip the openai-oauth provider.
                  console.error('[codex-materialize] failed to materialize tokens:', err);
                }
              }
            }
            // Cloud sessions persistence: when the deployment provisioned an
            // omni_sessions Postgres, redirect omniagents' history_db at it
            // (default is per-(project, agent) SQLite under OMNIAGENTS_HOME,
            // which is ephemeral on the launcher container's disk). Tenant id
            // is the team — matches the projects-db RLS scope so chat history
            // and project rows share the same isolation boundary.
            const sessionsUrl = process.env['OMNIAGENTS_HISTORY_URL'];
            const sessionsEnv: Record<string, string> = sessionsUrl
              ? {
                  OMNIAGENTS_HISTORY_BACKEND: 'postgres',
                  OMNIAGENTS_HISTORY_URL: sessionsUrl,
                  OMNIAGENTS_TENANT_ID: teamId,
                }
              : {};
            return {
              OMNI_RUNTIME_TOKEN: signRuntimeToken(runtimeTokenSecret, {
                tenantId: teamId,
                principalId,
                sessionId: uuidv4(),
              }),
              // Codex token-refresh callback. The runtime POSTs refreshed
              // OAuth tokens here so PgSecretStore stays current across spawns.
              // Empty when not in cloud → runtime skips the callback.
              ...(codexRefreshUrl ? { OMNI_CODEX_REFRESH_URL: codexRefreshUrl } : {}),
              ...sessionsEnv,
              // Redirect the child `omni serve` to this (team, principal) config
              // dir so it reads the materialized (secret-free) merged configs.
              XDG_CONFIG_HOME: join(configDir, '.config'),
              // The merged (team base ⊕ user overlay) .env, injected directly.
              ...parseEnvVars(settings.get('envVars') ?? ''),
              // Real values for the ${OMNI_SECRET_*} refs the materializer wrote
              // into the merged models.json / mcp.json — resolved by the agent's
              // loaders. settings.get returns the merged config, so origin-aware
              // resolution falls out: each provider's key is its own layer's.
              ...collectSecretEnv(
                settings.get('modelsConfig') ?? emptyModelsConfig(),
                settings.get('mcpConfig') ?? emptyMcpConfig()
              ),
            };
          }
        : undefined,
      // Cloud with Azure → agents run in a serverless ACI sandbox; host/devbox
      // are not selectable, but the user picks between the fast and desktop
      // ACI profiles. Local machines (`local:<id>`) are appended to the
      // allow-list per-tenant when the principal has any registered.
      allowedProfileNames: aciConfigured ? [ACI_PROFILE_NAME, ACI_DESKTOP_PROFILE_NAME] : undefined,
      // Computer-as-sandbox: when a machine registry exists (cloud), a
      // `local:<machineId>` pick spawns `omni serve` HERE with a host_bridge
      // profile pointing the sandbox at the user's laptop. No registry → the
      // picker never shows local machines, so the preparer is never invoked.
      hostBridge: machineRegistry
        ? new HostBridgePreparer(
            wsHandler,
            machineRegistry,
            configDir,
            Number.parseInt(process.env['PORT'] ?? '3001', 10)
          )
        : undefined,
    });
    // Keep this tenant's platform client in sync with its own credentials.
    // (omni-platform delegation for enterprise-platform builds; the ACI sandbox
    // path does not use a platform client — see note above.)
    const applyPlatformClient = (): void => {
      processManager.platformClient = createPlatformClient(settings.get('platform'), globalThis.fetch);
    };
    applyPlatformClient();
    settings.onDidAnyChange(() => applyPlatformClient());
    // Computer-as-sandbox: the per-principal set of `local:<machineId>` picker
    // entries is derived from the machine registry in `broadcastMachines` (a
    // sync cache read by `getStoreSnapshot`). The single `HostBridgePreparer`
    // injected above handles every machine — no per-machine client to refresh.
    // Cloud (ACI): artifacts live inside the workspace
    // (`/workspace/.omni-artifacts/<ticketId>`), which the ACI sandbox already
    // mounts from the workspace Azure Files share. So the control plane reads
    // that same share out-of-band, keyed `.omni-artifacts/<ticketId>` — no
    // second share. Tickets don't collide because the id is a globally-unique
    // nanoid. Unset on desktop/local → the host/docker resolver is used instead.
    const artAccount = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const artKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const artShare = process.env.OMNI_AZURE_FILE_SHARE ?? 'workspaces';
    const projectManager = new ProjectManager({
      store: settings as any,
      sendToWindow: tenantSend,
      processManager,
      // Postgres: a tenant-scoped PgProjectsRepo (RLS-isolated). SQLite: the
      // single shared repo + sync change-watcher (one tenant only).
      repo: pgPool ? new PgProjectsRepo(pgPool, teamId, replicaId) : asyncRepo,
      changeSeqRepo: pgPool ? undefined : syncRepo,
      skillsDir: join(configDir, 'skills'),
      // Teams: per-user WIP/review. Only in multi-tenant cloud — local stays global.
      ...(teamsEnabled ? { currentPrincipal: principalId } : {}),
      // Teams: toast the assignee (their own sessions) when assigned a ticket.
      ...(teamsEnabled
        ? {
            onAssign: (assignee: string, ticket: import('@/shared/types').Ticket) =>
              wsHandler.sendToPrincipalInTeam(teamId, assignee, 'toast:show', {
                level: 'info',
                title: 'Ticket assigned to you',
                description: ticket.title,
              }),
          }
        : {}),
      ...(artAccount && artKey
        ? {
            artifactStoreFor: () => new AzureFilesArtifactStore({ account: artAccount, key: artKey, share: artShare }),
          }
        : {}),
    });
    // Per-tenant extensions + browser, backed by the same tenant settings store
    // (enabledExtensions / browser profiles/tabs/history/bookmarks are per-user).
    const extension = new ExtensionManager({ store: settings as any, sendToWindow: tenantSend });
    const browser = buildBrowserContext(settings as any, tenantSend);
    ref = { projectManager, processManager, settings, extension, browser, configDir };
    tenants.set(tenantKey(teamId, principalId), ref);
    return ref;
  };

  const getTenant = (tenantId: string, principalId: string = tenantId): TenantInstance =>
    tenants.get(tenantKey(tenantId, principalId)) ?? createTenant(tenantId, principalId);
  const getProcessManager = (tenantId: string, principalId: string = tenantId): ProcessManager =>
    getTenant(tenantId, principalId).processManager;
  const getSettings = (tenantId: string, principalId: string = tenantId): SettingsStore =>
    getTenant(tenantId, principalId).settings;
  /**
   * Write a tenant's agent config (models/mcp/network) to disk from its store.
   * Cloud (Postgres): per-tenant `<configDir>/.config/omni_code` in `'refs'`
   * mode — secrets become `${OMNI_SECRET_*}` refs resolved from the agent env
   * (see getExtraEnv). Local (SQLite, single tenant): the shared config dir in
   * `'plaintext'` mode plus a real `.env`, mirroring desktop. The managed
   * `omni-projects` MCP entry is merged per transport.
   */
  const materializeTenant = (tenantId: string, principalId: string = tenantId): void => {
    const t = getTenant(tenantId, principalId);
    try {
      // Per-tenant config dir in cloud (matches the spawn's XDG_CONFIG_HOME), the
      // shared dir locally — the same dir omni serve's get_config_dir() resolves.
      const cfgDir = dbUrl ? join(t.configDir, '.config', 'omni_code') : getOmniConfigDir();
      materializeAgentConfig({
        configDir: cfgDir,
        models: t.settings.get('modelsConfig') ?? emptyModelsConfig(),
        mcp: t.settings.get('mcpConfig') ?? emptyMcpConfig(),
        network: t.settings.get('networkConfig') ?? emptyNetworkConfig(),
        mode: dbUrl ? 'refs' : 'plaintext',
        managedMcpEntry: dbUrl
          ? buildHttpMcpEntry(`http://127.0.0.1:${port}${MCP_PROJECTS_PATH}`)
          : buildStdioMcpEntry(getMcpBinPath()),
      });
      // Write `.env` next to the materialized configs in BOTH modes so omni
      // serve can read it into the sandbox container's manifest.environment
      // (`_inject_user_env`). Cloud also injects these into the agent *process*
      // env via getExtraEnv; this covers the container (the agent's tools).
      writeFileSync(join(cfgDir, '.env'), t.settings.get('envVars') ?? '', 'utf-8');
    } catch (err) {
      console.error(`[config-materializer] failed for tenant ${tenantId}:`, err);
    }
  };
  /**
   * Create (if needed) and fully hydrate a tenant's settings + projection. The
   * server awaits this on WS connect BEFORE processing any of the connection's
   * messages, so a write never races a late hydrate that would clobber either
   * cache. Settings hydrate first so the projection's init reads real prefs.
   */
  const ensureTenantReady = async (tenantId: string, principalId: string = tenantId): Promise<void> => {
    const t = getTenant(tenantId, principalId);
    if (t.settings instanceof CompositeSettingsStore) {
      await t.settings.whenReady;
    }
    await t.projectManager.whenReady;
    // Settings are hydrated now — write the agent's on-disk config so the next
    // omni-serve spawn for this tenant reads fresh model/mcp/network files.
    materializeTenant(tenantId, principalId);
  };
  const getStoreSnapshot = (tenantId: string, principalId: string = tenantId): StoreData => {
    let snapshot = getTenant(tenantId, principalId).projectManager.getStoreSnapshot();
    // Cloud/teams: the merged snapshot carries the shared team model/MCP keys —
    // mask them before they reach the renderer's mirrored store.
    if (pgPool) {
      snapshot = {
        ...snapshot,
        modelsConfig: maskModelsConfig(snapshot.modelsConfig ?? emptyModelsConfig()),
        mcpConfig: maskMcpConfig(snapshot.mcpConfig ?? emptyMcpConfig()),
      };
    }
    // Computer-as-sandbox: every registered machine for this principal becomes
    // a `local:<machineId>` profile entry. The renderer's picker pulls
    // labels + online status from `$machines` so we only need the id here.
    const localProfiles: string[] = (localMachineIdsByPrincipal.get(principalId) ?? []).map((id) => `local:${id}`);
    // Cloud/ACI: the picker offers the two ACI profiles plus the principal's
    // own machines. The default is COMPUTED (not blindly persisted) so a stale
    // value can't leak in — but we HONOR a persisted default that's valid in
    // this deployment: either ACI profile, or one of the user's registered
    // machines. Defaulting to `local:<my-laptop>` gives instant exploratory
    // chats (agent in cloud, sandbox on the laptop — no ACI spin-up). Anything
    // else (a leftover `host`/`devbox`, or a machine that's since been removed)
    // falls back to fast ACI.
    if (aciConfigured) {
      const validDefaults = new Set([ACI_PROFILE_NAME, ACI_DESKTOP_PROFILE_NAME, ...localProfiles]);
      const persisted = snapshot.defaultProfileName;
      const effectiveDefault = persisted && validDefaults.has(persisted) ? persisted : ACI_PROFILE_NAME;
      return {
        ...snapshot,
        defaultProfileName: effectiveDefault,
        availableSandboxProfiles: [ACI_PROFILE_NAME, ACI_DESKTOP_PROFILE_NAME, ...localProfiles],
      };
    }
    if (localProfiles.length > 0) {
      return {
        ...snapshot,
        availableSandboxProfiles: [...(snapshot.availableSandboxProfiles ?? ['host', 'devbox']), ...localProfiles],
      };
    }
    return snapshot;
  };

  const sandboxProfileLabel = (name: string): string => {
    if (name === 'host') {
      return 'This computer (no sandbox)';
    }
    if (name === 'devbox') {
      return 'Devbox (Docker)';
    }
    if (name === 'platform') {
      return 'Cloud (managed)';
    }
    if (name === ACI_PROFILE_NAME) {
      return 'Cloud · Fast';
    }
    if (name === ACI_DESKTOP_PROFILE_NAME) {
      return 'Cloud · Desktop (IDE + VNC)';
    }
    if (name.startsWith('local:')) {
      return `Local · ${name.slice('local:'.length, 'local:'.length + 8)}`;
    }
    return name.length > 0 ? name[0]!.toUpperCase() + name.slice(1) : name;
  };

  const getMcpContext = (tenantId: string, principalId: string = tenantId) => ({
    listSandboxProfiles: async () => {
      const snapshot = getStoreSnapshot(tenantId, principalId);
      const names =
        snapshot.availableSandboxProfiles && snapshot.availableSandboxProfiles.length > 0
          ? snapshot.availableSandboxProfiles
          : ['host', 'devbox'];
      return names.map((name) => ({
        name,
        label: sandboxProfileLabel(name),
        available: true,
        source: name.startsWith('local:') ? 'local-machine' : name.startsWith('aci') ? 'cloud' : 'builtin',
      }));
    },
    listTeamMembers: async () => {
      if (!teamsEnabled || !controlPlane) {
        return [];
      }
      const rows = await controlPlane.listMembers(tenantId);
      return rows.map((m) => ({
        user_id: m.user_id,
        display_name: m.display_name,
        email: m.email,
        role: m.role,
      }));
    },
    getCurrentPrincipal: async () => (teamsEnabled ? principalId : null),
  });
  /**
   * Broadcast a (team, principal) store snapshot. Cloud: to ONLY that principal's
   * sessions (the snapshot carries user-scoped keys that must not leak to other
   * team members). Local: to all (single user). Team-base changes that should
   * reach the whole team are broadcast separately by the team-settings handlers.
   */
  const sendSnapshot = (tenantId: string, principalId: string = tenantId): void => {
    if (pgPool) {
      wsHandler.sendToPrincipalInTeam(tenantId, principalId, 'store:changed', getStoreSnapshot(tenantId, principalId));
    } else {
      wsHandler.sendToTenant(tenantId, 'store:changed', getStoreSnapshot(tenantId, principalId));
    }
  };
  /**
   * A tenant-scoped repo for the HTTP MCP route. Postgres: a fresh
   * tenant-scoped PgProjectsRepo (RLS isolates it). SQLite: the single shared
   * repo (one tenant only). Writes flow through this repo, so the LISTEN/NOTIFY
   * (Postgres) and change-watcher (SQLite) layers keep ProjectManager caches
   * coherent automatically.
   */
  const getTenantRepo = (tenantId: string): IProjectsRepo =>
    pgPool ? new PgProjectsRepo(pgPool, tenantId) : asyncRepo;

  /** Profile claims pulled from EasyAuth headers for the users table. */
  type PrincipalClaims = { email?: string | null; displayName?: string | null; idp?: string | null };

  /**
   * Lazily migrate a principal into the teams model on first sight: ensure the
   * users row, create their personal team (id == principal, so existing project
   * rows keyed tenant_id = principal need no rewrite), and bifurcate their legacy
   * single-blob `user_settings` into team_settings (team base) + user_settings_v2
   * (overlay) per the layer map — so the effective merged config is unchanged
   * (no re-onboarding). Idempotent: skipped once the users row exists. PG only.
   */
  const ensureUserBootstrapped = async (principal: string, claims: PrincipalClaims = {}): Promise<void> => {
    if (!controlPlane || !pgPool) {
      return;
    }
    const existing = await controlPlane.getUser(principal);
    await controlPlane.ensureUser(principal, claims);
    if (existing) {
      return;
    } // already bootstrapped
    const label = claims.displayName ? `${claims.displayName}'s Team` : 'Personal';
    await controlPlane.createTeam({ id: principal, label, kind: 'personal', ownerId: principal });
    // Bifurcate any legacy settings blob (keyed by principal == personal team id).
    try {
      const legacy = await loadLegacyUserSettings(pgPool, principal);
      if (legacy) {
        const teamData: Record<string, unknown> = {};
        const userTop: Record<string, unknown> = {};
        const userByTeam: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(legacy)) {
          const cls = classify(k as keyof StoreData);
          if (cls.layer === 'team') {
            teamData[k] = v;
          } else if (cls.scope === 'team') {
            userByTeam[k] = v;
          } else {
            userTop[k] = v;
          } // global / identity / infra
        }
        await saveTeamSettings(pgPool, principal, teamData, replicaId);
        await saveUserSettings(pgPool, principal, { ...userTop, byTeam: { [principal]: userByTeam } }, replicaId);
      }
    } catch (err) {
      console.error(`[teams] legacy settings bifurcation failed for ${principal}:`, err);
    }
  };

  /**
   * Resolve the active team for a connecting principal. Returns the requested
   * team if the principal is a member; null if they requested a team they don't
   * belong to (caller rejects the connection); the personal team otherwise.
   */
  const resolveActiveTeam = async (principal: string, requested?: string): Promise<string | null> => {
    if (!controlPlane) {
      return principal;
    } // no teams → data scope is the principal
    const teams = await controlPlane.listTeamsForPrincipal(principal);
    if (requested) {
      return teams.some((t) => t.id === requested) ? requested : null;
    }
    // Default to the personal team (id == principal).
    return principal;
  };
  /** Resolve the caller's (team, principal) TenantInstance from the per-invoke HandlerContext. */
  const ctxTenant = (event: unknown): TenantInstance => {
    const c = event as HandlerContext;
    return getTenant(c.tenantId, c.principalId ?? c.tenantId);
  };
  /** Resolve the caller's tenant ProjectManager from the per-invoke HandlerContext. */
  const tenantPM = (event: unknown): ProjectManager => ctxTenant(event).projectManager;

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
  registerPageHandlers(
    ipc,
    (e) => tenantPM(e).pages,
    (e, projectId) => tenantPM(e).getProjectDir(projectId)
  );
  registerInboxHandlers(ipc, (e) => tenantPM(e).inbox);
  registerProcessHandlers(ipc, (e) => ctxTenant(e).processManager);
  registerExtensionHandlers(ipc, (e) => ctxTenant(e).extension);
  registerBrowserHandlers(ipc, (e) => ctxTenant(e).browser);

  // Eagerly create + hydrate the default tenant so its cache is warm before the
  // server serves requests (matters for Postgres, where hydration is real I/O).
  // SQLite mode only ever has this tenant. NOTE: other tenants are created
  // lazily and their initial hydration is not awaited per-request yet — fine
  // for brand-new tenants (empty cache is correct); cold-loading an existing
  // tenant's data on a fresh replica is a follow-up (await readiness in dispatch).
  const defaultTenant = getTenant(DEFAULT_TENANT);
  // Bridge handlers: register once on any bridge with a tenant resolver.
  defaultTenant.projectManager.bridge.registerIpc(ipc, (e) => tenantPM(e).bridge);
  // Local single-tenant server: import any pre-v23 on-disk config files into the
  // shared store once (cloud tenants start empty — never import a shared file).
  if (!dbUrl) {
    migrateAgentConfigFromFiles(getSettings(DEFAULT_TENANT) as unknown as SettingsConfigStore, getOmniConfigDir());
  }
  // Awaits settings + projection readiness AND materializes the agent config —
  // so the default tenant's on-disk config is current before serving requests.
  await ensureTenantReady(DEFAULT_TENANT);

  // Multi-replica cache coherence: LISTEN for Postgres change notifications and
  // re-hydrate the affected tenant's projection + settings — but only for
  // FOREIGN writes (other replicas / the MCP subprocess), since our own writes
  // already updated the cache. Notifications are debounced per tenant so a
  // burst collapses into one re-hydrate.
  let stopListener: (() => Promise<void>) | undefined;
  if (pgPool && dbUrl) {
    // Tenant instances are keyed `${teamId}::${principalId}`. A team/project
    // change ({t}) re-hydrates every member instance of that team; a user
    // settings change ({u}) re-hydrates that principal's instances.
    const pendingTeams = new Set<string>();
    const pendingPrincipals = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const flushRefresh = () => {
      refreshTimer = undefined;
      const teams = [...pendingTeams];
      const principals = [...pendingPrincipals];
      pendingTeams.clear();
      pendingPrincipals.clear();
      for (const [key, t] of tenants) {
        const sep = key.indexOf('::');
        const teamId = sep >= 0 ? key.slice(0, sep) : key;
        const principalId = sep >= 0 ? key.slice(sep + 2) : key;
        if (teams.includes(teamId)) {
          // Foreign project/team-base write: re-hydrate the projection + team layer.
          void t.projectManager.refreshFromExternal();
          if (t.settings instanceof CompositeSettingsStore) {
            void t.settings.reloadTeam().then(() => {
              materializeTenant(teamId, principalId);
              sendSnapshot(teamId, principalId);
            });
          }
        } else if (principals.includes(principalId) && t.settings instanceof CompositeSettingsStore) {
          // Foreign user-overlay write (same user, another replica/device).
          void t.settings.reloadUser().then(() => sendSnapshot(teamId, principalId));
        }
      }
    };
    stopListener = await createPgListener(dbUrl, 'omni_change', (payload) => {
      try {
        const { t, u, o, p } = JSON.parse(payload) as { t?: string; u?: string; o?: string; p?: string };
        if (p && t) {
          // Page-content change → push the new body to the team's editors.
          // Emit unconditionally (no origin skip); the renderer drops an echo.
          void new PgProjectsRepo(pgPool!, t)
            .getPageContent(p)
            .then((body) => wsHandler.sendToTenant(t, 'page:content-changed', p, body ?? ''))
            .catch(() => {});
          return;
        }
        if (o === replicaId) {
          return; // our own write — cache is already current
        }
        if (t) {
          pendingTeams.add(t);
        }
        if (u) {
          pendingPrincipals.add(u);
        }
        if ((t || u) && !refreshTimer) {
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
      return getStoreSnapshot(ctx.tenantId, ctx.principalId)[k];
    }
    return getSettings(ctx.tenantId, ctx.principalId).get(k);
  });
  ipc.handle('store:set-key', (ctx, key, value) => {
    const k = key as keyof import('@/shared/types').StoreData;
    if (PROJECT_KEYS.has(k)) {
      throw new Error(
        `store:set-key for project key "${String(k)}" is not allowed when SQLite is active. Use ProjectManager APIs.`
      );
    }
    getSettings(ctx.tenantId, ctx.principalId).set(k, value as never);
    sendSnapshot(ctx.tenantId, ctx.principalId);
  });
  ipc.handle('store:get', (ctx) => getStoreSnapshot(ctx.tenantId, ctx.principalId));
  ipc.handle('store:set', (ctx, data) => {
    const conflicts = [...PROJECT_KEYS].filter((k) => k in data);
    if (conflicts.length > 0) {
      throw new Error(`store:set with project keys [${conflicts.join(', ')}] is not allowed when SQLite is active.`);
    }
    getSettings(ctx.tenantId, ctx.principalId).store = data;
    sendSnapshot(ctx.tenantId, ctx.principalId);
  });
  ipc.handle('store:reset', (ctx) => {
    getSettings(ctx.tenantId, ctx.principalId).clear();
    sendSnapshot(ctx.tenantId, ctx.principalId);
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
    (e) => ctxTenant(e).configDir,
    (e) => getSettings((e as HandlerContext).tenantId, (e as HandlerContext).principalId) as never
  );
  registerSettingsConfigHandlers(
    ipc,
    (e) =>
      getSettings((e as HandlerContext).tenantId, (e as HandlerContext).principalId) as unknown as SettingsConfigStore,
    (e) => {
      const c = e as HandlerContext;
      materializeTenant(c.tenantId, c.principalId);
      sendSnapshot(c.tenantId, c.principalId);
    },
    // Cloud/teams: never echo shared secret values back to the renderer; a
    // save that didn't change a masked field preserves the stored value.
    pgPool ? { maskModels: maskModelsConfig, maskMcp: maskMcpConfig, restoreModels: restoreMaskedModels } : {}
  );
  registerGitCredentialHandlers(
    ipc,
    (e) =>
      getSettings((e as HandlerContext).tenantId, (e as HandlerContext).principalId) as unknown as SettingsConfigStore,
    // Cloud: git tokens are this principal's identity (PgSecretStore); local: on-disk store.
    (e) => (pgSecret ? pgSecret.forPrincipal((e as HandlerContext).principalId) : secretStore),
    (e) => {
      const c = e as HandlerContext;
      sendSnapshot(c.tenantId, c.principalId);
    }
  );
  // Cascade-delete chat/code-tab snapshots when the renderer closes a tab.
  // Pure file-system op (no per-tenant data), so the global ipc is fine.
  registerSnapshotHandlers(ipc);

  // GitHub / Azure DevOps discovery + GitHub status/unlink. All resolve their
  // token from the per-principal SecretStore (matching the Git-credential and
  // GitHub OAuth contract used by the Electron handlers). The interactive
  // sign-in (`github:link`, `codex:*`) still lives in Electron until the
  // server-mode device-flow UI exists.
  // Stable id used by Electron when storing the OAuth-linked github.com token.
  const GITHUB_CRED_ID = 'github-oauth';
  const resolveSecretsFor = (e: unknown) => {
    const c = e as HandlerContext;
    return pgSecret ? pgSecret.forPrincipal(c.principalId) : secretStore;
  };
  const resolveSettingsFor = (e: unknown) => {
    const c = e as HandlerContext;
    return getSettings(c.tenantId, c.principalId);
  };
  const requireGithubTokenFor = async (e: unknown): Promise<string> => {
    const token = await resolveSecretsFor(e).getGitToken(GITHUB_CRED_ID);
    if (!token) {
      throw new Error('No GitHub account linked');
    }
    return token;
  };

  ipc.handle('github:status', (e: unknown): GithubStatus => {
    const account = resolveSettingsFor(e).get('githubAccount');
    return account ? { connected: true, account } : { connected: false };
  });

  // Device-flow sign-in for server/browser mode. The Electron handler in
  // main/index.ts does the same thing; the only difference is openUrl can't
  // auto-open a tab from the server, so we no-op it and rely on the renderer
  // rendering verification_uri as a clickable link.
  ipc.handle('github:link', async (e: unknown): Promise<GithubStatus> => {
    const c = e as HandlerContext;
    const settings = resolveSettingsFor(e);
    const secrets = resolveSecretsFor(e);
    const send = pgPool
      ? <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void =>
          wsHandler.sendToPrincipalInTeam(c.tenantId, c.principalId, channel, ...args)
      : <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void =>
          wsHandler.sendToTenant(c.tenantId, channel, ...args);
    const { token, account } = await githubLink({
      fetchFn: globalThis.fetch,
      openUrl: () => {
        /* server mode: the renderer shows the link; we never auto-open */
      },
      onCode: (code) => send('github:device-code', code),
    });
    await secrets.setGitToken(GITHUB_CRED_ID, token);
    const creds = (settings.get('gitCredentials') ?? []).filter(
      (cred: GitCredential) => cred.id !== GITHUB_CRED_ID && cred.host !== account.host
    );
    const cred: GitCredential = {
      id: GITHUB_CRED_ID,
      host: account.host,
      username: 'x-access-token',
      last4: tokenLast4(token),
      label: `@${account.login} (GitHub)`,
      createdAt: Date.now(),
    };
    settings.set('gitCredentials', [...creds, cred]);
    settings.set('githubAccount', account);
    sendSnapshot(c.tenantId, c.principalId);
    return { connected: true, account };
  });

  ipc.handle('github:unlink', async (e: unknown) => {
    const c = e as HandlerContext;
    const settings = resolveSettingsFor(e);
    await resolveSecretsFor(e).deleteGitToken(GITHUB_CRED_ID);
    settings.set(
      'gitCredentials',
      (settings.get('gitCredentials') ?? []).filter((cred: GitCredential) => cred.id !== GITHUB_CRED_ID)
    );
    settings.delete('githubAccount');
    sendSnapshot(c.tenantId, c.principalId);
  });

  ipc.handle('github:list-owners', async (e: unknown): Promise<GithubOwner[]> => {
    const token = await requireGithubTokenFor(e);
    const account = resolveSettingsFor(e).get('githubAccount');
    // The linked user is always the first owner; their orgs follow.
    const self: GithubOwner[] = account
      ? [{ login: account.login, kind: 'user', ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) }]
      : [];
    return [...self, ...(await githubListOrgs(globalThis.fetch, token))];
  });

  ipc.handle('github:search-repos', async (e: unknown, query: GithubRepoQuery): Promise<RemoteRepo[]> => {
    return githubSearchRepos(globalThis.fetch, await requireGithubTokenFor(e), query);
  });

  // Codex device-flow sign-in.
  //
  //  - Local SQLite mode: tokens go to `<omni-config>/codex.json`, the same
  //    file the runtime reads (no XDG_CONFIG_HOME override, no per-principal
  //    nesting). The shared codex-auth helpers handle it.
  //  - Cloud (pgSecret) mode: the launcher container's filesystem is
  //    ephemeral (Azure Web App for Containers, no Azure Files mount on the
  //    launcher itself), so tokens MUST persist in Postgres. Per-principal,
  //    encrypted, RLS-isolated via PgSecretStore — same substrate as the
  //    user's git tokens. The per-spawn materializer (below) writes them to
  //    the per-principal config dir right before omni-serve starts.
  ipc.handle('codex:status', async (e: unknown) => {
    if (pgSecret) {
      const c = e as HandlerContext;
      const tokens = await pgSecret.getUserCodexTokens(c.principalId);
      const refresh = typeof tokens?.refresh === 'string' ? tokens.refresh : undefined;
      const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : undefined;
      return refresh ? { signedIn: true, ...(accountId ? { accountId } : {}) } : { signedIn: false };
    }
    return codexStatus();
  });

  ipc.handle('codex:logout', async (e: unknown) => {
    if (pgSecret) {
      const c = e as HandlerContext;
      await pgSecret.deleteUserCodexTokens(c.principalId);
      return;
    }
    codexLogout();
  });

  ipc.handle('codex:link', async (e: unknown) => {
    const c = e as HandlerContext;
    const send = pgPool
      ? <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void =>
          wsHandler.sendToPrincipalInTeam(c.tenantId, c.principalId, channel, ...args)
      : <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]): void =>
          wsHandler.sendToTenant(c.tenantId, channel, ...args);
    return codexDeviceLogin({
      onCode: (code) => send('codex:device-code', code),
      // Route persistence to PgSecretStore in cloud; fall back to the shared
      // file in local mode (codex-auth's default save).
      ...(pgSecret
        ? {
            save: (tokens) => pgSecret.setUserCodexTokens(c.principalId, tokens as unknown as Record<string, unknown>),
          }
        : {}),
    });
  });

  ipc.handle('azure:list-repos', async (e: unknown, input: { org: string; query: string }): Promise<RemoteRepo[]> => {
    const cred = (resolveSettingsFor(e).get('gitCredentials') ?? []).find(
      (c: GitCredential) => c.host === 'dev.azure.com'
    );
    const token = cred ? await resolveSecretsFor(e).getGitToken(cred.id) : undefined;
    if (!token) {
      throw new Error('No Azure DevOps token — add a dev.azure.com credential first');
    }
    return azureListRepos(globalThis.fetch, token, input.org, input.query);
  });
  // Teams control plane (cloud only). No-op channels in SQLite/local mode.
  registerTeamHandlers(ipc, controlPlane);

  // ---- Machines (computer-as-sandbox) ----
  //
  // Cloud-linked Electrons register themselves on their WS at boot; the cloud
  // tracks the live WS per machineId so it can dispatch reverse-RPC sandbox
  // lifecycle calls to the right Electron. PG-backed list survives restarts;
  // online flag reflects whether a live WS is currently bound. SQLite/local
  // mode has no registry (the renderer can't see other machines anyway), so
  // the channels are no-ops returning the empty list.
  ipc.handle('machine:register', async (e: unknown, info: unknown) => {
    const c = e as HandlerContext;
    if (!machineRegistry || !c.ws) {
      return { accepted: false };
    }
    const i = info as { machineId?: string; label?: string; platform?: string };
    if (!i?.machineId || typeof i.machineId !== 'string') {
      return { accepted: false };
    }
    await machineRegistry.bindFromWs(c.ws, c.principalId, {
      machineId: i.machineId,
      label: typeof i.label === 'string' && i.label.trim() ? i.label.trim() : 'Unnamed machine',
      platform: typeof i.platform === 'string' && i.platform.trim() ? i.platform.trim() : 'unknown',
    });
    return { accepted: true };
  });
  ipc.handle('machine:list', async (e: unknown) => {
    const c = e as HandlerContext;
    if (!machineRegistry) {
      return [];
    }
    return machineRegistry.listForPrincipal(c.principalId);
  });
  ipc.handle('machine:rename', async (e: unknown, machineId: unknown, label: unknown) => {
    const c = e as HandlerContext;
    if (!machineRegistry) {
      return [];
    }
    const id = String(machineId);
    const next = String(label ?? '').trim() || 'Unnamed machine';
    await machineRegistry.rename(c.principalId, id, next);
    return machineRegistry.listForPrincipal(c.principalId);
  });
  ipc.handle('machine:remove', async (e: unknown, machineId: unknown) => {
    const c = e as HandlerContext;
    if (!machineRegistry) {
      return [];
    }
    await machineRegistry.remove(c.principalId, String(machineId));
    return machineRegistry.listForPrincipal(c.principalId);
  });

  // Team-base (shared) agent config editing — admin-gated. A change affects
  // every member, so refresh all local instances of the team and broadcast.
  const teamDefaultsStatus = (s: SettingsStore): import('@/shared/types').TeamDefaultsStatus =>
    s instanceof CompositeSettingsStore
      ? {
          hasModels: s.getTeamBase('modelsConfig') != null,
          hasMcp: s.getTeamBase('mcpConfig') != null,
          hasEnv: s.getTeamBase('envVars') != null,
          hasNetwork: s.getTeamBase('networkConfig') != null,
        }
      : { hasModels: false, hasMcp: false, hasEnv: false, hasNetwork: false };
  const refreshTeamMembers = (teamId: string): void => {
    for (const [key, t] of tenants) {
      if (!key.startsWith(`${teamId}::`)) {
        continue;
      }
      const principalId = key.slice(teamId.length + 2);
      if (t.settings instanceof CompositeSettingsStore) {
        void t.settings.reloadTeam().then(() => {
          materializeTenant(teamId, principalId);
          sendSnapshot(teamId, principalId);
        });
      }
    }
  };
  // Identity for the renderer's "my work" filters: the caller's principal in
  // teams/cloud, null in single-user/local (→ filters fall back to "all").
  ipc.handle('team:whoami', (e) => (teamsEnabled ? (e as HandlerContext).principalId : null));

  const teamSummariesFor = async (principal: string): Promise<import('@/shared/types').TeamSummary[]> => {
    if (!controlPlane) {
      return [];
    }
    return (await controlPlane.listTeamsForPrincipal(principal)).map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      role: r.role,
    }));
  };

  // --- Self-service membership ---
  ipc.handle('team:leave', async (e) => {
    const c = e as HandlerContext;
    if (!controlPlane) {
      return [];
    }
    const role = await controlPlane.getMembershipRole(c.tenantId, c.principalId);
    if (role === 'owner') {
      throw new Error('Transfer ownership before leaving the team.');
    }
    await controlPlane.removeMember(c.tenantId, c.principalId);
    return teamSummariesFor(c.principalId);
  });
  ipc.handle('team:rename', async (e, label) => {
    const c = e as HandlerContext;
    if (!controlPlane) {
      return [];
    }
    await requireRole(controlPlane, c.tenantId, c.principalId, 'admin');
    await controlPlane.renameTeam(c.tenantId, String(label).trim() || 'Team');
    return teamSummariesFor(c.principalId);
  });
  ipc.handle('team:delete', async (e) => {
    const c = e as HandlerContext;
    if (!controlPlane) {
      return [];
    }
    await requireRole(controlPlane, c.tenantId, c.principalId, 'owner');
    const team = await controlPlane.getTeam(c.tenantId);
    if (team?.kind === 'personal') {
      throw new Error('Cannot delete your personal team.');
    }
    // Block deletion while the team still owns projects (project data is keyed
    // by tenant_id, not FK-cascaded — require it emptied first).
    const projects = await getTenantRepo(c.tenantId).listProjects();
    if (projects.length > 0) {
      throw new Error('Remove the team’s projects before deleting it.');
    }
    await controlPlane.deleteTeam(c.tenantId);
    return teamSummariesFor(c.principalId);
  });
  ipc.handle('team:transfer-ownership', async (e, userId) => {
    const c = e as HandlerContext;
    if (!controlPlane) {
      return [];
    }
    await requireRole(controlPlane, c.tenantId, c.principalId, 'owner');
    const target = String(userId);
    await controlPlane.setRole(c.tenantId, target, 'owner');
    await controlPlane.setRole(c.tenantId, c.principalId, 'admin');
    return (await controlPlane.listMembers(c.tenantId)).map((m) => ({
      userId: m.user_id,
      email: m.email,
      displayName: m.display_name,
      role: m.role,
    }));
  });

  ipc.handle('team-settings:status', (e) => {
    const c = e as HandlerContext;
    return teamDefaultsStatus(getSettings(c.tenantId, c.principalId));
  });
  ipc.handle('team-settings:publish-from-mine', async (e) => {
    const c = e as HandlerContext;
    if (controlPlane) {
      await requireRole(controlPlane, c.tenantId, c.principalId, 'admin');
    }
    const s = getSettings(c.tenantId, c.principalId);
    if (s instanceof CompositeSettingsStore) {
      // Adopt the caller's effective (merged) config as the team default.
      s.setTeamBase('modelsConfig', s.get('modelsConfig'));
      s.setTeamBase('mcpConfig', s.get('mcpConfig'));
      s.setTeamBase('envVars', s.get('envVars'));
      s.setTeamBase('networkConfig', s.get('networkConfig'));
      await s.flush();
      refreshTeamMembers(c.tenantId);
    }
    return teamDefaultsStatus(s);
  });
  ipc.handle('team-settings:clear', async (e) => {
    const c = e as HandlerContext;
    if (controlPlane) {
      await requireRole(controlPlane, c.tenantId, c.principalId, 'admin');
    }
    const s = getSettings(c.tenantId, c.principalId);
    if (s instanceof CompositeSettingsStore) {
      s.setTeamBase('modelsConfig', emptyModelsConfig());
      s.setTeamBase('mcpConfig', emptyMcpConfig());
      s.setTeamBase('envVars', '');
      s.setTeamBase('networkConfig', emptyNetworkConfig());
      await s.flush();
      refreshTeamMembers(c.tenantId);
    }
    return teamDefaultsStatus(s);
  });

  registerMigrationHandlers(ipc, (e) => {
    const c = e as HandlerContext;
    const settings = getSettings(c.tenantId, c.principalId);
    return {
      get: () => settings.get('pagesMigration') ?? null,
      set: (value) => {
        if (value === null) {
          settings.delete('pagesMigration');
        } else {
          settings.set('pagesMigration', value);
        }
        sendSnapshot(c.tenantId, c.principalId);
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
  ipc.handle('platform:get-auth', (ctx) => getSettings(ctx.tenantId, ctx.principalId).get('platform') ?? null);
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
        await new Promise<void>((r) => {
          setTimeout(r, deviceCode.interval * 1000);
        });
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
    const settings = getSettings(ctx.tenantId, ctx.principalId);
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
    const settings = getSettings(ctx.tenantId, ctx.principalId);
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
      t.settings instanceof CompositeSettingsStore ? t.settings.flush() : Promise.resolve(),
    ]);
    const results = await Promise.allSettled([syncManager.dispose(), cleanupOmniInstall(), ...tenantCleanups]);
    closeProjectDb();
    if (pgPool) {
      await pgPool.end();
    }
    if (pgAdminPool) {
      await pgAdminPool.end();
    }
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0) {
      console.error('Error cleaning up global managers:', errors);
    }
  };

  return {
    cleanupGlobalManagers,
    getProcessManager,
    ensureTenantReady,
    getTenantRepo,
    getMcpContext,
    runtimeTokenSecret,
    teamsEnabled,
    controlPlane,
    ensureUserBootstrapped,
    resolveActiveTeam,
    /** Cloud-only secret store — wires the /api/codex/refresh callback. */
    pgSecret,
    /** Cloud-only — `server/index.ts` releases the WS binding on close. */
    machineRegistry,
  };
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
