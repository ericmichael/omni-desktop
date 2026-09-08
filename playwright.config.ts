import { defineConfig, devices } from '@playwright/test';

import type { E2eOptions } from './tests/e2e/fixtures/test';

const visualProof = process.env.VISUAL_PROOF === '1';
const proofSlowMo = Number(process.env.VISUAL_PROOF_SLOW_MO_MS ?? '120');
const proofViewport = { width: 1920, height: 1080 };

export default defineConfig<E2eOptions>({
  testDir: './tests/e2e/specs',
  // Playwright's final trace-writing slot uses the project timeout, not a
  // test.setTimeout override. Sustained proof runs need time to flush video
  // and trace artifacts after their workload has already completed.
  timeout: Number(process.env.OMNI_CHAT_SOAK_MS ?? 0) > 0 ? 600_000 : 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: visualProof ? 'artifacts/playwright-proof-report' : 'artifacts/playwright-report',
        open: 'never',
      },
    ],
  ],
  outputDir: visualProof ? 'artifacts/playwright-proof-results' : 'artifacts/playwright-results',
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: visualProof ? 'on' : 'only-on-failure',
    trace: visualProof ? 'on' : 'retain-on-failure',
    video: visualProof ? 'on' : 'retain-on-failure',
    launchOptions: visualProof ? { slowMo: proofSlowMo } : undefined,
  },
  projects: [
    {
      name: 'server-local',
      use: {
        ...devices['Desktop Chrome'],
        ...(visualProof ? { viewport: proofViewport } : {}),
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
