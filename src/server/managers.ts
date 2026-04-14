import { readFileSync } from 'fs';
import { join } from 'path';

import { createConsoleManager } from '@/main/console-manager';
import { createExtensionManager } from '@/main/extension-manager';
import { createOmniInstallManager } from '@/main/omni-install-manager';
import { PlatformClient } from '@/main/platform-client';
import { createPlatformClient,isEnterpriseBuild, mapSandboxProfiles, PLATFORM_URL } from '@/main/platform-mode';
import { createProcessManager } from '@/main/process-manager';
import { createProjectManager } from '@/main/project-manager';
import { getOmniConfigDir } from '@/main/util';
import { ServerIpcAdapter } from '@/server/ipc-adapter';
import type { ServerStore } from '@/server/store';
import type { WsHandler } from '@/server/ws-handler';
import {
  registerConfigHandlers,
  registerSkillsHandlers,
  registerUtilHandlers,
} from '@/shared/ipc-handlers';
import type { IpcRendererEvents } from '@/shared/types';

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
    }),
  });

  const [, cleanupProject] = createProjectManager({
    ipc,
    sendToWindow: sendToAll,
    store: store as any,
    processManager,
  });

  const [, cleanupExtensions] = createExtensionManager({
    ipc,
    store: store as any,
    sendToWindow: sendToAll,
  });

  // Wire platform client for enterprise mode
  const updatePlatformClients = () => {
    const platform = store.get('platform');
    const client = createPlatformClient(platform, globalThis.fetch);
    processManager.platformClient = client;
  };
  updatePlatformClients();
  const unsubPlatform = store.onDidAnyChange(() => updatePlatformClients());

  // Global status getters
  ipc.handle('omni-install-process:get-status', () => omniInstall.getStatus());

  // Store change notifications — broadcast to all clients
  store.onDidAnyChange((data) => {
    wsHandler.sendToAll('store:changed', data);
  });

  // Store handlers
  ipc.handle('store:get-key', (_, key) => store.get(key));
  ipc.handle('store:set-key', (_, key, value) => store.set(key, value));
  ipc.handle('store:get', () => store.store);
  ipc.handle('store:set', (_, data) => {
    store.store = data;
  });
  ipc.handle('store:reset', () => {
    store.clear();
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
  const OMNI_CONFIG_DIR = getOmniConfigDir();
  registerConfigHandlers(ipc, OMNI_CONFIG_DIR);
  registerUtilHandlers(ipc, { fetchFn: globalThis.fetch, launcherVersion });
  registerSkillsHandlers(ipc, OMNI_CONFIG_DIR);

  // Desktop-only handlers — stubbed for browser mode
  ipc.handle('util:select-directory', () => null);
  ipc.handle('util:select-file', () => null);
  ipc.handle('util:open-directory', () => '');

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
      cleanupProject(),
      cleanupOmniInstall(),
      cleanupProcessManager(),
      cleanupExtensions(),
    ]);
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
