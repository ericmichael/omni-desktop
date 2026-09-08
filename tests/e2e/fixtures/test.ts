import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  _electron as electron,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  expect,
  type Page,
  test as base,
  type TestInfo,
} from '@playwright/test';
import electronExecutablePath from 'electron';
import { startDeterministicModelServer } from 'tests/e2e/support/model-server';
import type { ManagedProcess } from 'tests/e2e/support/process';
import { killTcpPort, startProcess, waitForHttpOk } from 'tests/e2e/support/process';
import { attachProofVideo, visualProofEnabled } from 'tests/e2e/support/proof';
import {
  createE2eState,
  type E2eCodexCredentialState,
  type E2eMcpConfigState,
  type E2eState,
  inspectElectronCodexCredential,
  inspectElectronMcpConfig,
  seedElectronState,
  seedServerState,
  type SeedState,
} from 'tests/e2e/support/state';

import { AgentHostControlClient } from '@/main/agent-host-control-client';
import type { CodeTab } from '@/shared/types';

export type LaunchMode = 'server-local' | 'electron-local';

export type E2eOptions = {
  launchMode: LaunchMode;
  seedState: SeedState;
  extraHostProfile: boolean;
};

type E2eFixtures = E2eOptions & {
  app: E2eApp;
  appPage: Page;
  mode: LaunchMode;
};

type LaunchedApp = {
  page: Page;
  releaseBackground?: () => void;
  resizeWindow?: (width: number, height: number) => Promise<void>;
  setMinimized?: (minimized: boolean) => Promise<void>;
  captureScreenshot: () => Promise<Buffer>;
  close: (options?: { crash?: boolean; backendOnly?: boolean }) => Promise<void>;
  restartBackend?: () => Promise<void>;
  inspectModelRequests?: () => { marker: string; model: string }[];
};

type E2eApp = {
  readonly page: Page;
  releaseBackground: () => void;
  resizeWindow: (width: number, height: number) => Promise<void>;
  setMinimized: (minimized: boolean) => Promise<void>;
  readonly workspaceDir: string;
  captureScreenshot: () => Promise<Buffer>;
  inspectCodexCredential: () => E2eCodexCredentialState;
  inspectMcpConfig: () => E2eMcpConfigState;
  inspectModelRequests: () => { marker: string; model: string }[];
  restart: (options?: { crash?: boolean; backendOnly?: boolean }) => Promise<Page>;
  inspectChatCleanup: () => { tabs: CodeTab[]; jobs: CodeTab[]; runtimePids: number[] };
  inspectChatResources: () => Promise<{
    hosts: number;
    environments: number;
    activeEnvironments: number;
    workspaces: number;
    rssBytes: number;
    fileDescriptors: number;
    childProcesses: number;
    workerPids: number[];
  }>;
};

type ObservedHost = { hostId: string; wsUrl: string; controlToken: string; pid: number };

const serverUrl = process.env.E2E_SERVER_URL ?? 'http://127.0.0.1:3001/';
const proofViewport = { width: 1920, height: 1080 };
const proofSlowMo = Number(process.env.VISUAL_PROOF_SLOW_MO_MS ?? '120');

function videoOptions(testInfo: TestInfo, launchIndex: number) {
  return visualProofEnabled
    ? {
        dir: testInfo.outputPath(`videos-${launchIndex}`),
        size: proofViewport,
        showActions: { duration: 900, position: 'bottom-right' as const, fontSize: 18 },
      }
    : undefined;
}

function viewportOptions() {
  return visualProofEnabled ? { viewport: proofViewport } : {};
}

async function attachPageVideo(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const video = page.video();
  const path = video ? await video.path().catch(() => null) : null;
  await attachProofVideo(testInfo, name, path);
}

async function launchServerLocal(
  browser: Browser,
  state: E2eState,
  testInfo: TestInfo,
  launchIndex: number,
  seedState: SeedState
): Promise<LaunchedApp> {
  let serverProcess: ManagedProcess | null = null;
  let context: BrowserContext | null = null;
  const responseText =
    seedState === 'lazy-host-first-message'
      ? 'HOST_FIRST_MESSAGE_READY'
      : seedState === 'lazy-devbox-first-message'
        ? 'DEVBOX_FIRST_MESSAGE_READY'
        : null;
  const modelServer =
    responseText && !process.env.E2E_REAL_MODELS_FILE && !process.env.E2E_SERVER_URL
      ? await startDeterministicModelServer(responseText)
      : null;

  const startBackend = () => {
    if (process.env.E2E_SERVER_URL) {
      return;
    }
    const parsed = new URL(serverUrl);
    serverProcess = startProcess({
      command: 'npm',
      args: ['run', 'start:server'],
      cwd: process.cwd(),
      env: {
        HOME: state.homeDir,
        XDG_CONFIG_HOME: state.xdgConfigHome,
        HOST: parsed.hostname,
        PORT: parsed.port || '3001',
        OMNI_WEB_AUTO_OPEN: 'false',
        ...(process.env.OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS
          ? { OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS: process.env.OMNI_PROXY_DYNAMIC_RUNTIME_SHIMS }
          : {}),
        ...(process.env.OMNI_PROXY_RUNTIME_SHIMS
          ? { OMNI_PROXY_RUNTIME_SHIMS: process.env.OMNI_PROXY_RUNTIME_SHIMS }
          : {}),
        OPENAI_BASE_URL:
          modelServer?.baseUrl ??
          process.env.OPENAI_BASE_URL ??
          process.env.SANDBOX_OPENAI_BASE_URL ??
          'http://127.0.0.1:9/v1',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key',
      },
      forwardOutput: process.env.E2E_FORWARD_SERVER_LOGS === '1',
    });
  };
  startBackend();

  const crashBackend = () => {
    const stored = JSON.parse(readFileSync(path.join(state.homeDir, '.config', 'Omni Code', 'config.json'), 'utf8'));
    const owner = [...(stored.codeTabs ?? []), ...(stored.chatCleanupJobs ?? [])].find(
      (tab) => tab.runtimeOwner
    )?.runtimeOwner;
    if (!owner || !serverProcess) {
      throw new Error('Test launcher runtime owner not found');
    }
    serverProcess.crashDescendant(Number(String(owner).split(':').at(-1)));
  };

  await waitForHttpOk(serverUrl, 90_000);
  context = await browser.newContext({ ...viewportOptions(), recordVideo: videoOptions(testInfo, launchIndex) });
  const page = await context.newPage();
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });

  return {
    page,
    captureScreenshot: () => page.screenshot({ animations: 'disabled' }),
    inspectModelRequests: () => [...(modelServer?.observations ?? [])],
    releaseBackground: () => modelServer?.releaseBackground(),
    restartBackend: async () => {
      if (process.env.E2E_SERVER_URL) {
        throw new Error('Cannot restart an externally managed server');
      }
      // Keep the browser context (including IndexedDB drafts/uploads) and
      // deterministic model endpoint alive. A backend crash is not a fresh
      // browser profile, and must exercise the real renderer reconnect path.
      crashBackend();
      startBackend();
      await waitForHttpOk(serverUrl, 90_000);
    },
    close: async (options) => {
      const recoveryLog = serverProcess
        ?.logs()
        .split('\n')
        .filter((line) => line.includes('[chat-cleanup]'))
        .join('\n');
      if (recoveryLog) {
        console.log(recoveryLog);
      }
      await context?.close().catch(() => undefined);
      await attachPageVideo(page, testInfo, `server-local video ${launchIndex}`);
      if (options?.backendOnly) {
        const stored = JSON.parse(
          readFileSync(path.join(state.homeDir, '.config', 'Omni Code', 'config.json'), 'utf8')
        );
        const owner = [...(stored.codeTabs ?? []), ...(stored.chatCleanupJobs ?? [])].find(
          (tab) => tab.runtimeOwner
        )?.runtimeOwner;
        if (!owner || !serverProcess) {
          throw new Error('Test launcher runtime owner not found');
        }
        serverProcess.crashDescendant(Number(String(owner).split(':').at(-1)));
      } else {
        await serverProcess?.stop(options?.crash ? 'SIGKILL' : 'SIGTERM');
      }
      await modelServer?.close();
      if (serverProcess) {
        await killTcpPort(new URL(serverUrl).port || '3001');
      }
    },
  };
}

async function launchElectronLocal(
  state: E2eState,
  testInfo: TestInfo,
  launchIndex: number,
  seedState: SeedState
): Promise<LaunchedApp> {
  // When the suite is launched from another Electron host (for example Codex
  // Desktop), do not inherit that host's renderer URL. electron-vite uses this
  // variable to select a dev renderer, which would make the child Electron
  // window display the host application instead of this built test app.
  const { ELECTRON_RENDERER_URL: _hostRendererUrl, ...electronEnv } = process.env;
  const firstMessageResponse =
    seedState === 'lazy-host-first-message'
      ? 'HOST_FIRST_MESSAGE_READY'
      : seedState === 'lazy-devbox-first-message'
        ? 'DEVBOX_FIRST_MESSAGE_READY'
        : null;
  const modelServer =
    firstMessageResponse && !process.env.E2E_REAL_MODELS_FILE
      ? await startDeterministicModelServer(firstMessageResponse)
      : null;
  const electronApp: ElectronApplication = await electron.launch({
    executablePath: electronExecutablePath,
    args: [...(process.env.E2E_ELECTRON_X11 === '1' ? ['--ozone-platform=x11'] : []), '.'],
    cwd: process.cwd(),
    env: {
      ...electronEnv,
      XDG_CONFIG_HOME: state.xdgConfigHome,
      OMNIAGENTS_HOME: path.join(state.rootDir, 'omniagents'),
      OPENAI_BASE_URL:
        modelServer?.baseUrl ??
        process.env.OPENAI_BASE_URL ??
        process.env.SANDBOX_OPENAI_BASE_URL ??
        'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key',
      OMNI_SKIP_DOCKER_PRUNE: '1',
      DISPLAY: process.env.DISPLAY ?? ':0',
    },
    recordVideo: videoOptions(testInfo, launchIndex),
    slowMo: visualProofEnabled ? proofSlowMo : undefined,
  });
  if (process.env.E2E_FORWARD_ELECTRON_LOGS === '1') {
    electronApp.process().stdout?.pipe(process.stdout);
    electronApp.process().stderr?.pipe(process.stderr);
  }
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  // The first BrowserWindow begins on the lightweight splash document and
  // then navigates to the renderer. Wait for stable product UI before taking
  // a BrowserWindow handle; otherwise the navigation can destroy its JS
  // execution context while proof-mode sizing is in flight.
  await page.getByText('New chat', { exact: true }).first().waitFor({ state: 'visible', timeout: 120_000 });
  const browserWindow = await electronApp.browserWindow(page);
  if (visualProofEnabled) {
    await browserWindow.evaluate((window, size) => window.setSize(size.width, size.height), proofViewport);
    await page.setViewportSize(proofViewport);
  }
  await page.waitForLoadState('domcontentloaded');

  return {
    page,
    resizeWindow: async (width, height) => {
      await browserWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
      await page.setViewportSize({ width, height });
    },
    releaseBackground: () => modelServer?.releaseBackground(),
    setMinimized: async (minimized) => {
      await browserWindow.evaluate((window, value) => (value ? window.minimize() : window.restore()), minimized);
      await expect.poll(() => browserWindow.evaluate((window) => window.isMinimized())).toBe(minimized);
    },
    // Use the same renderer screenshot path as browser proofs. Native
    // capturePage can return a stale compositor surface (or a host-WM crop)
    // after DOM assertions pass, making the artifact contradict the test.
    captureScreenshot: () => page.screenshot({ animations: 'disabled' }),
    close: async () => {
      await electronApp.close().catch(() => undefined);
      await attachPageVideo(page, testInfo, `electron-local video ${launchIndex}`);
      await modelServer?.close().catch(() => undefined);
    },
  };
}

export const test = base.extend<E2eFixtures>({
  launchMode: ['server-local', { option: true }],
  seedState: ['blank', { option: true }],
  extraHostProfile: [false, { option: true }],
  mode: async ({ launchMode }, fixtureUse) => {
    await fixtureUse(launchMode);
  },
  app: async ({ browser, launchMode, seedState, extraHostProfile }, fixtureUse, testInfo) => {
    const testId = `${launchMode}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
    const state = createE2eState(testId);
    if (extraHostProfile) {
      const directory = path.join(state.xdgConfigHome, 'omni_code', 'sandbox');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'soak-host.yml'),
        'version: 1\nclient:\n  type: host\nmanifest:\n  root: ${workspace_dir}\n'
      );
    }
    if (launchMode === 'server-local') {
      seedServerState(state, seedState);
    } else {
      seedElectronState(state, seedState);
    }

    let launchIndex = 0;
    const launch = () => {
      launchIndex += 1;
      const currentLaunch = launchIndex;
      return launchMode === 'server-local'
        ? launchServerLocal(browser, state, testInfo, currentLaunch, seedState)
        : launchElectronLocal(state, testInfo, currentLaunch, seedState);
    };

    let launched = await launch();
    const observedHosts = new Map<string, ObservedHost>();
    const app: E2eApp = {
      releaseBackground: () => launched.releaseBackground?.(),
      get page() {
        return launched.page;
      },
      resizeWindow: (width, height) =>
        launched.resizeWindow?.(width, height) ?? launched.page.setViewportSize({ width, height }),
      setMinimized: async (minimized) => {
        if (!launched.setMinimized) {
          throw new Error('Native minimization requires electron-local');
        }
        await launched.setMinimized(minimized);
      },
      get workspaceDir() {
        return state.workspaceDir;
      },
      captureScreenshot: () => launched.captureScreenshot(),
      inspectCodexCredential: () => inspectElectronCodexCredential(state),
      inspectMcpConfig: () => inspectElectronMcpConfig(state),
      inspectModelRequests: () => launched.inspectModelRequests?.() ?? [],
      inspectChatResources: async () => {
        const journal = path.join(state.xdgConfigHome, 'omni_code', 'chat-runtime-journal');
        const claims = existsSync(journal)
          ? readdirSync(journal)
              .filter((file) => file.endsWith('.json'))
              .flatMap((file) => JSON.parse(readFileSync(path.join(journal, file), 'utf8')) as ObservedHost[])
          : [];
        for (const claim of claims) {
          observedHosts.set(claim.hostId, claim);
        }
        for (const [id, host] of observedHosts) {
          try {
            const stat = readFileSync(`/proc/${host.pid}/stat`, 'utf8').split(') ')[1];
            if (stat?.startsWith('Z ')) {
              observedHosts.delete(id);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
            observedHosts.delete(id);
          }
        }
        const hosts = [...observedHosts.values()];
        const totals = {
          hosts: hosts.length,
          environments: 0,
          activeEnvironments: 0,
          workspaces: 0,
          rssBytes: 0,
          fileDescriptors: 0,
          childProcesses: 0,
          workerPids: [] as number[],
        };
        for (const host of hosts) {
          totals.rssBytes +=
            Number(readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
          totals.fileDescriptors += readdirSync(`/proc/${host.pid}/fd`).length;
          const workerPids = readFileSync(`/proc/${host.pid}/task/${host.pid}/children`, 'utf8')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          totals.childProcesses += workerPids.length;
          totals.workerPids.push(...workerPids);
          // Privileged credentials stay in the Node fixture, never in page
          // state, reports or snapshots. Expose aggregate counts only.
          const control = new AgentHostControlClient(host.wsUrl, host.controlToken, 10_000);
          try {
            const resources = (await control.call('agent_host_list_resources', {})) as {
              agent_host_id: string;
              workspaces: unknown[];
              environments: { state: string }[];
            };
            if (resources.agent_host_id !== host.hostId) {
              throw new Error('Resource probe host identity changed');
            }
            totals.workspaces += resources.workspaces.length;
            totals.environments += resources.environments.length;
            totals.activeEnvironments += resources.environments.filter((env) => env.state !== 'stopped').length;
          } finally {
            control.close();
          }
        }
        return totals;
      },
      inspectChatCleanup: () => {
        const base = launchMode === 'server-local' ? path.join(state.homeDir, '.config') : state.xdgConfigHome;
        const stored = JSON.parse(readFileSync(path.join(base, 'Omni Code', 'config.json'), 'utf8'));
        const journal = path.join(state.xdgConfigHome, 'omni_code', 'chat-runtime-journal');
        const runtimePids = existsSync(journal)
          ? ([
              ...new Set(
                readdirSync(journal)
                  .filter((file) => file.endsWith('.json'))
                  .flatMap((file) =>
                    JSON.parse(readFileSync(path.join(journal, file), 'utf8')).map(
                      (claim: { pid: number }) => claim.pid
                    )
                  )
              ),
            ] as number[])
          : [];
        return { tabs: stored.codeTabs ?? [], jobs: stored.chatCleanupJobs ?? [], runtimePids };
      },
      restart: async (options) => {
        if (options?.backendOnly && launched.restartBackend) {
          await launched.restartBackend();
          return launched.page;
        }
        await launched.close(options);
        launched = await launch();
        return launched.page;
      },
    };

    try {
      await fixtureUse(app);
    } finally {
      await launched.close();
      state.cleanup();
    }
  },
  appPage: async ({ app }, fixtureUse) => {
    await fixtureUse(app.page);
  },
});

export { expect };
