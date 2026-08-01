import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';

import { CHAT_SUGGESTIONS } from '@/renderer/features/Code/empty-suggestions';

const tourPrompt = CHAT_SUGGESTIONS.find((suggestion) => suggestion.label === 'Show me around')!.prompt;

async function captureState(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
}

async function waitForChat(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('How can I help you today?').first()).toBeVisible({ timeout: 90_000 });
}

test.describe('lazy session launch guidance', () => {
  test.describe('without a workspace', () => {
    test.use({ seedState: 'no-workspace' });

    test('explains the prerequisite inline and links to workspace settings', async ({ app }, testInfo) => {
      await waitForChat(app.page);
      await app.page.evaluate(async () => {
        await window.electron.ipcRenderer.invoke('store:set-key', 'workspaceDir', '');
      });
      await expect(
        app.page.getByRole('heading', { name: 'Choose a workspace folder to start chatting' })
      ).toBeVisible();
      await expect(app.page.getByPlaceholder('How can I help you today?')).toBeDisabled();
      await captureState(app.page, testInfo, '01-workspace-required');

      await app.page.getByRole('button', { name: 'Open workspace settings' }).click();
      await expect(app.page.getByText('Workspace directory', { exact: true })).toBeVisible();
      await captureState(app.page, testInfo, '02-workspace-settings');
    });
  });

  test.describe('with a workspace', () => {
    test.use({ seedState: 'lazy-ready' });

    test('shows first-message guidance and starts from a suggested prompt', async ({ app }, testInfo) => {
      await waitForChat(app.page);
      await expect(app.page.getByText(/Your first message starts a session in/)).toBeVisible();
      await expect(app.page.getByRole('button', { name: 'Plan my week' })).toBeVisible();
      await captureState(app.page, testInfo, '03-ready-to-start');

      await app.page.getByRole('button', { name: 'Show me around' }).click();
      await expect(app.page.getByText(tourPrompt)).toBeVisible();
      await expect(app.page.getByRole('status').filter({ hasText: 'Starting' })).toBeVisible();
      await captureState(app.page, testInfo, '04-starting-with-pending-intent');
    });
  });

  test.describe('when launch fails after intent', () => {
    test.use({ seedState: 'lazy-error-pending' });

    test('keeps the pending prompt beside an actionable error', async ({ app }, testInfo) => {
      await waitForChat(app.page);
      await app.page.getByRole('button', { name: 'Show me around' }).click();
      await expect(app.page.getByText(tourPrompt)).toBeVisible();
      await expect(app.page.getByRole('alert')).toContainText('Couldn’t start', { timeout: 90_000 });
      await expect(app.page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await captureState(app.page, testInfo, '05-error-with-pending-intent');
    });
  });

  test.describe('when an existing launch fails', () => {
    test.use({ seedState: 'lazy-error-empty' });

    test('uses the same actionable error without inventing pending intent', async ({ app }, testInfo) => {
      await waitForChat(app.page);
      await expect(app.page.getByRole('alert')).toContainText('Couldn’t start', { timeout: 90_000 });
      await expect(app.page.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(app.page.getByText(tourPrompt)).toHaveCount(0);
      await captureState(app.page, testInfo, '06-error-without-pending-intent');
    });
  });
});
