import { defineConfig, devices } from '@playwright/test';

import type { E2eOptions } from './tests/e2e/fixtures/test';

export default defineConfig<E2eOptions>({
  testDir: './tests/e2e/specs',
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  outputDir: 'artifacts/playwright-results',
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'server-local',
      use: {
        ...devices['Desktop Chrome'],
        launchMode: 'server-local',
      },
    },
    {
      name: 'electron-local',
      use: {
        launchMode: 'electron-local',
      },
    },
  ],
});
