import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { invokeApp } from 'tests/e2e/support/invoke';

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

  test.describe('when Host overrides a Devbox default', () => {
    test.use({ seedState: 'lazy-host-first-message' });

    test('starts the selected Host environment from the first submitted message', async ({ app }, testInfo) => {
      test.setTimeout(360_000);
      if (process.env.E2E_FORWARD_ELECTRON_LOGS === '1') {
        app.page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
      }
      await waitForChat(app.page);
      await app.page.getByRole('button', { name: 'Devbox (Docker)', exact: true }).click();
      await app.page.getByRole('menuitem', { name: 'This computer (no sandbox)' }).click();
      await expect(app.page.getByRole('button', { name: 'This computer (no sandbox)', exact: true })).toBeVisible();

      const prompt = 'Respond with exactly HOST_FIRST_MESSAGE_READY and nothing else.';
      const composer = app.page.getByPlaceholder('How can I help you today?');
      await composer.fill(prompt);
      await composer.press('Enter');
      await expect(app.page.getByText(prompt, { exact: true }).last()).toBeVisible();

      await expect
        .poll(
          async () => {
            const current = await invokeApp<{ type?: string }>(
              app.page,
              'agent-process:get-status',
              'chat-e2e-host-first-message'
            );
            return current?.type;
          },
          { timeout: 300_000 }
        )
        .toBe('running');
      await expect(app.page.getByRole('alert').filter({ hasText: 'Couldn’t start' })).toHaveCount(0);
      await expect(app.page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({
        timeout: 180_000,
      });
      await expect(app.page.getByTestId('chat-transcript').getByText(prompt, { exact: true })).toHaveCount(1);
      await captureState(app.page, testInfo, 'host-first-message-agent-response');
    });
  });

  test.describe('when Devbox is selected for the first message', () => {
    test.use({ seedState: 'lazy-devbox-first-message' });

    test('starts the selected Devbox and returns an agent response', async ({ app }, testInfo) => {
      test.setTimeout(600_000);
      if (process.env.E2E_FORWARD_ELECTRON_LOGS === '1') {
        app.page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
      }
      await waitForChat(app.page);
      await expect(app.page.getByRole('button', { name: 'Devbox (Docker)', exact: true })).toBeVisible();

      const expectedResponse = process.env.E2E_REAL_MODELS_FILE
        ? 'DEVBOX_FIRST_MESSAGE_READY /workspace'
        : 'DEVBOX_FIRST_MESSAGE_READY';
      const prompt = process.env.E2E_REAL_MODELS_FILE
        ? `Use the shell to run pwd. Then respond with exactly ${expectedResponse} and nothing else.`
        : `Respond with exactly ${expectedResponse} and nothing else.`;
      const composer = app.page.getByPlaceholder('How can I help you today?');
      await composer.fill(prompt);
      await composer.press('Enter');
      await expect(app.page.getByText(prompt, { exact: true }).last()).toBeVisible();

      if (process.env.E2E_REAL_MODELS_FILE) {
        const approveOnce = app.page.getByRole('button', { name: 'Approve Once', exact: true });
        await expect(approveOnce).toBeVisible({ timeout: 180_000 });
        await approveOnce.click();
      }

      await expect
        .poll(
          async () => {
            const current = await invokeApp<{ type?: string }>(
              app.page,
              'agent-process:get-status',
              'chat-e2e-devbox-first-message'
            );
            return current?.type;
          },
          { timeout: 480_000 }
        )
        .toBe('running');
      await expect(app.page.getByRole('alert').filter({ hasText: 'Couldn’t start' })).toHaveCount(0);
      await expect(app.page.getByText(expectedResponse, { exact: true }).last()).toBeVisible({
        timeout: 180_000,
      });
      await expect(app.page.getByTestId('chat-transcript').getByText(prompt, { exact: true })).toHaveCount(1);
      await captureState(app.page, testInfo, 'devbox-first-message-agent-response');
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
