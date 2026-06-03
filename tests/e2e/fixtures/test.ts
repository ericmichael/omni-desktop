import { type Browser, chromium, expect, type Page, test as base } from '@playwright/test';
import type { ManagedProcess } from 'tests/e2e/support/process';
import { killTcpPort, startProcess, waitForHttpOk } from 'tests/e2e/support/process';
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

async function findElectronRendererPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes('localhost') || page.url().startsWith('file:')) {
          return page;
        }
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error('Timed out waiting for Electron renderer page');
}

async function launchServerLocal(browser: Browser, state: E2eState): Promise<LaunchedApp> {
  let serverProcess: ManagedProcess | null = null;

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
  const page = await browser.newPage();
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });

  return {
    page,
    close: async () => {
      await page.close().catch(() => undefined);
      await serverProcess?.stop();
      if (serverProcess) {
        await killTcpPort(new URL(serverUrl).port || '3001');
      }
    },
  };
}

async function launchElectronLocal(state: E2eState, workerIndex: number): Promise<LaunchedApp> {
  const debugPort = process.env.E2E_ELECTRON_CDP_PORT ?? String(9444 + workerIndex);
  const cdpUrl = process.env.E2E_ELECTRON_CDP_URL ?? `http://127.0.0.1:${debugPort}`;
  let electronProcess: ManagedProcess | null = null;
  const launchedElectron = !process.env.E2E_ELECTRON_CDP_URL;

  if (launchedElectron) {
    electronProcess = startProcess({
      command: 'npm',
      args: ['run', 'dev'],
      cwd: process.cwd(),
      env: {
        XDG_CONFIG_HOME: state.xdgConfigHome,
        OMNI_DEBUG_PORT: debugPort,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? process.env.SANDBOX_OPENAI_BASE_URL ?? 'http://127.0.0.1:9/v1',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key',
        DISPLAY: process.env.DISPLAY ?? ':0',
      },
    });
  }

  await waitForHttpOk(`${cdpUrl}/json/version`, 120_000);
  const connectedBrowser = await chromium.connectOverCDP(cdpUrl);
  const page = await findElectronRendererPage(connectedBrowser, 120_000);
  await page.waitForLoadState('domcontentloaded');

  return {
    page,
    close: async () => {
      await connectedBrowser.close().catch(() => undefined);
      await electronProcess?.stop();
      if (launchedElectron) {
        await killTcpPort(debugPort);
      }
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

    const launch = () =>
      launchMode === 'server-local'
        ? launchServerLocal(browser, state)
        : launchElectronLocal(state, testInfo.workerIndex);

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
