import {
  type Browser,
  type BrowserContext,
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test as base,
  type TestInfo,
} from '@playwright/test';
import electronExecutablePath from 'electron';
import type { ManagedProcess } from 'tests/e2e/support/process';
import { killTcpPort, startProcess, waitForHttpOk } from 'tests/e2e/support/process';
import { attachProofVideo, visualProofEnabled } from 'tests/e2e/support/proof';
import {
  createE2eState,
  type E2eState,
  seedElectronState,
  seedServerState,
  type SeedState,
} from 'tests/e2e/support/state';

export type LaunchMode = 'server-local' | 'electron-local';

export type E2eOptions = {
  launchMode: LaunchMode;
  seedState: SeedState;
};

type E2eFixtures = E2eOptions & {
  app: E2eApp;
  appPage: Page;
  mode: LaunchMode;
};

type LaunchedApp = {
  page: Page;
  close: () => Promise<void>;
};

type E2eApp = {
  readonly page: Page;
  restart: () => Promise<Page>;
};

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
  launchIndex: number
): Promise<LaunchedApp> {
  let serverProcess: ManagedProcess | null = null;
  let context: BrowserContext | null = null;

  if (!process.env.E2E_SERVER_URL) {
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
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? process.env.SANDBOX_OPENAI_BASE_URL ?? 'http://127.0.0.1:9/v1',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key',
      },
    });
  }

  await waitForHttpOk(serverUrl, 90_000);
  context = await browser.newContext({ ...viewportOptions(), recordVideo: videoOptions(testInfo, launchIndex) });
  const page = await context.newPage();
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });

  return {
    page,
    close: async () => {
      await context?.close().catch(() => undefined);
      await attachPageVideo(page, testInfo, `server-local video ${launchIndex}`);
      await serverProcess?.stop();
      if (serverProcess) {
        await killTcpPort(new URL(serverUrl).port || '3001');
      }
    },
  };
}

async function launchElectronLocal(state: E2eState, testInfo: TestInfo, launchIndex: number): Promise<LaunchedApp> {
  const electronApp: ElectronApplication = await electron.launch({
    executablePath: electronExecutablePath,
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: state.xdgConfigHome,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? process.env.SANDBOX_OPENAI_BASE_URL ?? 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key',
      DISPLAY: process.env.DISPLAY ?? ':0',
    },
    recordVideo: videoOptions(testInfo, launchIndex),
    slowMo: visualProofEnabled ? proofSlowMo : undefined,
  });
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  if (visualProofEnabled) {
    const browserWindow = await electronApp.browserWindow(page);
    await browserWindow.evaluate((window, size) => window.setSize(size.width, size.height), proofViewport);
    await page.setViewportSize(proofViewport);
  }
  await page.waitForLoadState('domcontentloaded');

  return {
    page,
    close: async () => {
      await electronApp.close().catch(() => undefined);
      await attachPageVideo(page, testInfo, `electron-local video ${launchIndex}`);
    },
  };
}

export const test = base.extend<E2eFixtures>({
  launchMode: ['server-local', { option: true }],
  seedState: ['blank', { option: true }],
  mode: async ({ launchMode }, fixtureUse) => {
    await fixtureUse(launchMode);
  },
  app: async ({ browser, launchMode, seedState }, fixtureUse, testInfo) => {
    const testId = `${launchMode}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
    const state = createE2eState(testId);
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
        ? launchServerLocal(browser, state, testInfo, currentLaunch)
        : launchElectronLocal(state, testInfo, currentLaunch);
    };

    let launched = await launch();
    const app: E2eApp = {
      get page() {
        return launched.page;
      },
      restart: async () => {
        await launched.close();
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
