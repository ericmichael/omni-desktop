/**
 * IPC handlers for the enterprise platform integration.
 *
 * Registers platform:* channels that the renderer uses for sign-in/sign-out.
 * In open-source builds, `platform:is-enterprise` returns false and the UI
 * hides all platform-related controls.
 */

import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { ipcMain } from 'electron';
import type Store from 'electron-store';

import type { FetchFn } from '@/main/agent-process';
import { PlatformClient } from '@/main/platform-client';
import { isEnterpriseBuild, PLATFORM_URL } from '@/main/platform-mode';
import type { IpcEvents, IpcRendererEvents, PlatformCredentials, StoreData } from '@/shared/types';

export function registerPlatformIpc(arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  store: Store<StoreData>;
  fetchFn: FetchFn;
}) {
  const { ipc, sendToWindow, store, fetchFn } = arg;

  ipc.handle('platform:is-enterprise', () => {
    return isEnterpriseBuild();
  });

  ipc.handle('platform:get-auth', () => {
    if (!isEnterpriseBuild()) {
return null;
}
    return store.get('platform') ?? null;
  });

  ipc.handle('platform:sign-in', async () => {
    if (!isEnterpriseBuild()) {
      throw new Error('Not an enterprise build');
    }

    // Step 1: Initiate device code flow
    const deviceCode = await PlatformClient.initiateDeviceCode(PLATFORM_URL, fetchFn);

    // Step 2: Poll for token completion in the background
    // The renderer will show the user_code and verification_uri
    void pollForAuth(deviceCode.device_code, deviceCode.interval, deviceCode.expires_in);

    return {
      userCode: deviceCode.user_code,
      verificationUri: deviceCode.verification_uri,
      message: deviceCode.message,
    };
  });

  ipc.handle('platform:sign-out', () => {
    store.delete('platform');
    // Reset to no-isolation default. Step 6 introduces an
    // OmniPlatformSandboxClient so the `platform` profile becomes a real
    // SandboxClient that fails cleanly when unauthenticated; until then,
    // bouncing to `host` keeps the user productive after sign-out.
    store.set('defaultProfileName', 'host');
    sendToWindow('platform:auth-changed', null);
  });

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
      }, fetchFn);

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

  // --- Internal ---

  /**
   * Fetch the effective policy from the platform. After v22 the platform's
   * sandbox_profiles are no longer materialized into the store — step 6
   * turns the platform path into a SandboxClient and the profiles flow
   * through the same profile-resolution chain as everything else. For now
   * we just touch the network so token refresh runs and the credentials
   * stay valid.
   */
  async function fetchAndApplyPolicy(credentials: PlatformCredentials): Promise<void> {
    try {
      const client = new PlatformClient(
        { url: PLATFORM_URL, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
        fetchFn
      );
      client.onTokenRefresh = (newToken) => {
        const current = store.get('platform');
        if (current) {
          store.set('platform', { ...current, accessToken: newToken });
        }
      };
      await client.getPolicy('omni_code');
    } catch (e) {
      console.warn('[Platform] Failed to fetch policy:', (e as Error).message);
    }
  }

  async function pollForAuth(deviceCode: string, interval: number, expiresIn: number): Promise<void> {
    const maxAttempts = Math.floor(expiresIn / interval);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise<void>((r) => setTimeout(r, interval * 1000));

      try {
        const result = await PlatformClient.pollForToken(PLATFORM_URL, deviceCode, fetchFn);

        if (result.status === 'authenticated' && result.access_token && result.refresh_token) {
          const credentials: PlatformCredentials = {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            userEmail: result.user?.email,
            userName: result.user?.name,
            userRole: result.user?.role,
            domains: result.user?.domains,
          };

          store.set('platform', credentials);
          sendToWindow('platform:auth-changed', credentials);

          // Fetch policy and apply sandbox profiles
          await fetchAndApplyPolicy(credentials);
          return;
        }

        if (result.status === 'expired') {
          // Device code expired — user didn't complete auth in time
          return;
        }

        // status === 'pending' — keep polling
      } catch {
        // Network error — keep trying
      }
    }
  }

  /** Refresh policy from the platform. Call on startup if credentials exist. */
  const refreshPolicy = async () => {
    const creds = store.get('platform');
    if (creds?.accessToken && isEnterpriseBuild()) {
      await fetchAndApplyPolicy(creds);
    }
  };

  const cleanup = () => {
    ipcMain.removeHandler('platform:is-enterprise');
    ipcMain.removeHandler('platform:get-auth');
    ipcMain.removeHandler('platform:sign-in');
    ipcMain.removeHandler('platform:sign-out');
    ipcMain.removeHandler('platform:get-dashboards');
  };

  return { cleanup, refreshPolicy };
}
