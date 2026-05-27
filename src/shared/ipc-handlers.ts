/**
 * Shared IPC handler registration for channels that are identical across
 * the Electron main process and the browser-mode server. Both transports
 * accept an `IIpcListener` so they can share a single implementation for
 * config:*, util:*, and skills:* handlers. Electron-specific handlers
 * (dialog, shell, window references) remain in `src/main/index.ts`.
 */
import { randomUUID } from 'node:crypto';

import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { WebSocket as WsWebSocket } from 'ws';

import { emptyMcpConfig, emptyModelsConfig, emptyNetworkConfig } from '@/lib/agent-config';
import type { SkillStore } from '@/main/skills';
import { installSkillFromFile, listSkills, setSkillEnabled, uninstallSkill } from '@/main/skills';
import {
  checkBundleUpdates,
  fetchMarketplace,
  installMarketplacePlugin,
  updateMarketplacePlugin,
} from '@/main/skills-marketplace';
import {
  checkModelsConfigured,
  ensureDirectory,
  getCliSymlinkPath,
  getDefaultWorkspaceDir,
  getHomeDirectory,
  getOmniCliPath,
  getOmniRuntimeInfo,
  getOperatingSystem,
  installCliToPath,
  isCliInstalledInPath,
  isDirectory,
  isFile,
  listRuntimeModels,
  pathExists,
  testModelConnection,
  validateConfigPath,
  validateUserPath,
} from '@/main/util';
import { tokenLast4 } from '@/shared/git-credentials';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { SecretStore } from '@/shared/secret-store';
import type {
  GitCredential,
  GitCredentialInput,
  McpConfig,
  ModelsConfig,
  NetworkConfig,
  StoreData,
} from '@/shared/types';

export interface UtilHandlerOptions {
  /**
   * Fetch implementation used for URL probing. Electron passes a thin wrapper
   * around `net.fetch`; server mode passes `globalThis.fetch`.
   */
  fetchFn: typeof globalThis.fetch;
  /**
   * Launcher version string. Electron reads `app.getVersion()`; server mode
   * reads the bundled package.json at startup. Both pass the resolved value
   * in so this module doesn't depend on Electron.
   */
  launcherVersion: string;
}

/**
 * Register `config:*` handlers. All file I/O goes through `validateConfigPath`
 * so callers cannot escape the config directory.
 */
export function registerConfigHandlers(ipc: IIpcListener, configDir: string): void {
  ipc.handle('config:get-omni-config-dir', () => configDir);
  ipc.handle('config:get-env-file-path', () => join(configDir, '.env'));

  ipc.handle('config:read-json-file', async (_: unknown, filePath: string) => {
    validateConfigPath(filePath, configDir);
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-json-file', async (_: unknown, filePath: string, data: unknown) => {
    validateConfigPath(filePath, configDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  });

  ipc.handle('config:read-text-file', async (_: unknown, filePath: string) => {
    validateConfigPath(filePath, configDir);
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  });

  ipc.handle('config:write-text-file', async (_: unknown, filePath: string, content: string) => {
    validateConfigPath(filePath, configDir);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
  });
}

/**
 * Minimal store surface the settings-config handlers need. Satisfied by
 * electron-store, the server `ServerStore`, and the per-tenant `PgSettingsStore`.
 */
export interface SettingsConfigStore {
  get<K extends keyof StoreData>(key: K): StoreData[K] | undefined;
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
}

/**
 * Register the typed `settings:*` agent-config channels. These replace the
 * path-based `config:*` file I/O for the four configs whose source of truth is
 * the store: model providers, MCP servers, network policy, and `.env`. The
 * store backend (electron-store / ServerStore / per-tenant PgSettingsStore) is
 * resolved per-invoke; `afterWrite` is the transport's hook to broadcast
 * `store:changed` and re-materialize the agent's on-disk config.
 */
/**
 * Optional secret-masking hooks (cloud/teams). `maskModels`/`maskMcp` blank out
 * shared secret values before a config reaches the renderer; `restoreModels`
 * re-applies the stored value on save so a sentinel round-trip never clobbers
 * the real secret. Omitted in Electron/local (a user's own keys, no masking).
 */
export interface SettingsSecretMask {
  maskModels?: (c: ModelsConfig) => ModelsConfig;
  maskMcp?: (c: McpConfig) => McpConfig;
  restoreModels?: (incoming: ModelsConfig, stored: ModelsConfig) => ModelsConfig;
}

export function registerSettingsConfigHandlers(
  ipc: IIpcListener,
  resolveStore: (event: unknown) => SettingsConfigStore,
  afterWrite: (event: unknown) => void,
  mask: SettingsSecretMask = {}
): void {
  ipc.handle('settings:get-models-config', (e: unknown) => {
    const c = resolveStore(e).get('modelsConfig') ?? emptyModelsConfig();
    return mask.maskModels ? mask.maskModels(c) : c;
  });
  ipc.handle('settings:set-models-config', (e: unknown, config: ModelsConfig) => {
    const store = resolveStore(e);
    const next = mask.restoreModels ? mask.restoreModels(config, store.get('modelsConfig') ?? emptyModelsConfig()) : config;
    store.set('modelsConfig', next);
    afterWrite(e);
  });
  ipc.handle('settings:get-mcp-config', (e: unknown) => {
    const c = resolveStore(e).get('mcpConfig') ?? emptyMcpConfig();
    return mask.maskMcp ? mask.maskMcp(c) : c;
  });
  ipc.handle('settings:set-mcp-config', (e: unknown, config: McpConfig) => {
    resolveStore(e).set('mcpConfig', config);
    afterWrite(e);
  });
  ipc.handle(
    'settings:get-network-config',
    (e: unknown) => resolveStore(e).get('networkConfig') ?? emptyNetworkConfig()
  );
  ipc.handle('settings:set-network-config', (e: unknown, config: NetworkConfig) => {
    resolveStore(e).set('networkConfig', config);
    afterWrite(e);
  });
  ipc.handle('settings:get-env', (e: unknown) => resolveStore(e).get('envVars') ?? '');
  ipc.handle('settings:set-env', (e: unknown, content: string) => {
    resolveStore(e).set('envVars', content);
    afterWrite(e);
  });
}

/**
 * Register the write-only `git-cred:*` channels. Metadata (the `GitCredential[]`
 * list) lives in the store and is safe to broadcast; the token bytes go to the
 * injected `SecretStore` and never round-trip to the renderer. `set` upserts by
 * host — host-scoped means one credential per host, reused across projects.
 * `afterWrite` broadcasts `store:changed` (the secret store has no snapshot).
 */
export function registerGitCredentialHandlers(
  ipc: IIpcListener,
  resolveStore: (event: unknown) => SettingsConfigStore,
  resolveSecretStore: (event: unknown) => SecretStore,
  afterWrite: (event: unknown) => void
): void {
  const list = (e: unknown): GitCredential[] => resolveStore(e).get('gitCredentials') ?? [];

  ipc.handle('git-cred:list', (e: unknown) => list(e));

  ipc.handle('git-cred:set', async (e: unknown, input: GitCredentialInput) => {
    const host = input.host.trim().toLowerCase();
    const username = input.username.trim();
    const token = input.token;
    if (!host || !token) {
      throw new Error('git-cred:set requires a host and a token');
    }
    const store = resolveStore(e);
    const secrets = resolveSecretStore(e);
    const existing = list(e);
    // Upsert by host: replace the existing host entry (reusing its id so the
    // secret slot is overwritten) or mint a fresh one.
    const prior = existing.find((c) => c.host === host);
    const id = prior?.id ?? randomUUID();
    await secrets.setGitToken(id, token);
    const next: GitCredential = {
      id,
      host,
      username: username || 'git',
      last4: tokenLast4(token),
      createdAt: prior?.createdAt ?? Date.now(),
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    };
    store.set('gitCredentials', [...existing.filter((c) => c.id !== id), next]);
    afterWrite(e);
    return store.get('gitCredentials') ?? [];
  });

  ipc.handle('git-cred:delete', async (e: unknown, id: string) => {
    const store = resolveStore(e);
    await resolveSecretStore(e).deleteGitToken(id);
    store.set(
      'gitCredentials',
      (store.get('gitCredentials') ?? []).filter((c) => c.id !== id)
    );
    afterWrite(e);
    return store.get('gitCredentials') ?? [];
  });
}

/**
 * Register the portable subset of `util:*` handlers. Electron-only handlers
 * (`util:select-directory`, `util:select-file`, `util:open-directory`) are
 * NOT registered here and must be wired separately by each transport.
 */
export function registerUtilHandlers(ipc: IIpcListener, opts: UtilHandlerOptions): void {
  const { fetchFn, launcherVersion } = opts;

  ipc.handle('util:get-default-install-dir', () => join(getHomeDirectory(), 'omni'));
  ipc.handle('util:get-default-workspace-dir', () => getDefaultWorkspaceDir());
  ipc.handle('util:ensure-directory', async (_: unknown, dirPath: string) => {
    // Cap depth on writes so a misbehaving (or hostile) client can't ask
    // the main process to mkdir thousands of nested directories. Fix 2.1
    // doesn't apply here — DirectoryBrowserDialog legitimately needs to
    // pick locations outside the config dir — so this is the cheap floor:
    // null bytes and depth, no path-prefix restriction.
    validateUserPath(dirPath, { checkDepth: true });
    return ensureDirectory(dirPath);
  });
  ipc.handle('util:list-directory', async (_: unknown, dirPath: string) => {
    validateUserPath(dirPath);
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: join(dirPath, e.name), isDirectory: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });
  ipc.handle('util:get-home-directory', () => getHomeDirectory());
  ipc.handle('util:get-is-directory', async (_: unknown, path: string) => {
    validateUserPath(path);
    return isDirectory(path);
  });
  ipc.handle('util:get-is-file', async (_: unknown, path: string) => {
    validateUserPath(path);
    return isFile(path);
  });
  ipc.handle('util:get-path-exists', async (_: unknown, path: string) => {
    validateUserPath(path);
    return pathExists(path);
  });
  ipc.handle('util:get-os', () => getOperatingSystem());
  ipc.handle('util:get-launcher-version', () => launcherVersion);
  ipc.handle('util:get-omni-runtime-info', () => getOmniRuntimeInfo());
  ipc.handle('util:install-cli-to-path', () => installCliToPath());
  ipc.handle('util:get-cli-in-path-status', async () => {
    const installed = await isCliInstalledInPath();
    return { installed, symlinkPath: getCliSymlinkPath() };
  });
  ipc.handle('util:check-models-configured', () => checkModelsConfigured());
  ipc.handle('util:test-model-connection', (_: unknown, modelRef?: string) => testModelConnection(modelRef));
  ipc.handle('util:list-models', () => listRuntimeModels());

  ipc.handle('util:rebuild-sandbox-image', async () => {
    // Sandbox Dockerfiles now live in omni-code. Trigger rebuild via the CLI.
    const omniPath = getOmniCliPath();
    try {
      const { execFile: execFileAsync } = await import('child_process');
      const { promisify } = await import('util');
      const execFilePromise = promisify(execFileAsync);
      await execFilePromise(omniPath, ['sandbox', '--rebuild', '--output', 'json'], { timeout: 600_000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  ipc.handle('util:check-url', async (_: unknown, url: string) => {
    try {
      const response = await fetchFn(url, { method: 'GET' });
      return response.status < 500;
    } catch {
      return false;
    }
  });

  ipc.handle('util:check-ws', async (_: unknown, url: string) => {
    try {
      return await new Promise<boolean>((resolvePromise) => {
        let settled = false;

        const settle = (result: boolean, socket?: WsWebSocket, timer?: ReturnType<typeof setTimeout>) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          if (socket) {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
          }
          resolvePromise(result);
        };

        const socket = new WsWebSocket(url);
        const timer = setTimeout(() => settle(false, socket), 2000);

        socket.on('open', () => settle(true, socket, timer));
        socket.on('error', () => settle(false, socket, timer));
        socket.on('close', () => settle(false, socket, timer));
      });
    } catch {
      return false;
    }
  });
}

/**
 * Register `skills:*` handlers. Skills live under a config dir (the
 * `<dir>/skills` + `<dir>/skills-disabled` folders) with source/bundle metadata
 * in the store. Both are resolved per-invoke from the event: `() => x` for the
 * single-tenant Electron app, or per-tenant on the server (each tenant gets its
 * own skills directory + settings store).
 */
export function registerSkillsHandlers(
  ipc: IIpcListener,
  resolveConfigDir: (event: unknown) => string,
  resolveStore: (event: unknown) => SkillStore
): void {
  ipc.handle('skills:list', (e: unknown) => listSkills(resolveConfigDir(e), resolveStore(e)));
  ipc.handle('skills:install', (e: unknown, filePath: string) =>
    installSkillFromFile(resolveConfigDir(e), filePath, resolveStore(e))
  );
  ipc.handle('skills:uninstall', (e: unknown, name: string) =>
    uninstallSkill(resolveConfigDir(e), name, resolveStore(e))
  );
  ipc.handle('skills:set-enabled', (e: unknown, name: string, enabled: boolean) =>
    setSkillEnabled(resolveConfigDir(e), name, enabled)
  );
  ipc.handle('skills:fetch-marketplace', (_: unknown, repo: string) => fetchMarketplace(repo));
  ipc.handle('skills:install-marketplace-plugin', (e: unknown, repo: string, name: string) =>
    installMarketplacePlugin(resolveConfigDir(e), repo, name, resolveStore(e))
  );
  ipc.handle('skills:update-marketplace-plugin', (e: unknown, repo: string, name: string) =>
    updateMarketplacePlugin(resolveConfigDir(e), repo, name, resolveStore(e))
  );
  ipc.handle('skills:check-bundle-updates', (e: unknown) => checkBundleUpdates(resolveStore(e)));
}
