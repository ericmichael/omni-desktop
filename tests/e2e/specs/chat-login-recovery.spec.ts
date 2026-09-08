import type { WebSocketRoute } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('explicit browser credential expiry preserves a draft and attachment through authenticated reload', async ({
  app,
  mode,
}, info) => {
  test.skip(mode !== 'server-local', 'Same-origin browser login boundary; standalone Electron uses IPC');
  test.setTimeout(180_000);
  const page = app.page;
  let expired = false;
  let rejections = 0;
  let outer: WebSocketRoute | undefined;
  await page.route('**/api/ws-token', async (route) => {
    if (expired) {
      rejections++;
      await route.fulfill({ status: 401, json: { error: 'Login expired' } });
    } else {
      await route.continue();
    }
  });
  await page.routeWebSocket(/\/ws\?sessionId=/, (socket) => {
    outer = socket;
    socket.connectToServer();
  });
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    (window as any).loginRecoverySends = [];
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'start_run' && frame.params?.prompt === 'LOGIN_RECOVERED_DRAFT') {
        (window as any).loginRecoverySends.push(frame.params);
      }
      return send.call(this, data);
    };
  });
  await page.reload();
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input.fill('LOGIN_RECOVERY_SETUP');
  await input.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await input.fill('LOGIN_RECOVERED_DRAFT');
  await page
    .locator('.chat-input-footer')
    .filter({ has: input })
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'login-draft.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bytes retained through login expiry'),
    });
  await expect(page.getByText('login-draft.txt', { exact: true })).toBeVisible();
  expired = true;
  expect(outer).toBeDefined();
  await outer!.close({ code: 4401, reason: 'Login expired' });
  await expect(page.getByText('Disconnected from the backend.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Sign in again, then reload/)).toBeVisible();
  await expect(input).toHaveValue('LOGIN_RECOVERED_DRAFT');
  await attachProofPng(info, 'credential rejection preserves draft and attachment', await page.screenshot());
  expect(rejections).toBe(1);
  // Still unauthenticated on a fresh document: the auth gate must expose an
  // error/reload path rather than hiding the shell banner behind a spinner.
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByText('Unable to start Omni', { exact: true })).toBeVisible();
  await attachProofPng(info, 'cold expired login has a recovery action', await page.screenshot());
  expect(rejections).toBe(2);
  // Local edge simulation: the identity provider has accepted the same user
  // again. Reload is the product's explicit recovery action, not a test resend.
  expired = false;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page
    .getByRole('list', { name: 'Recents' })
    .getByRole('button', { name: 'LOGIN_RECOVERY_SETUP', exact: true })
    .click();
  await expect(input).toHaveValue('LOGIN_RECOVERED_DRAFT');
  await expect(page.getByText('login-draft.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log').getByText('LOGIN_RECOVERED_DRAFT', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  const sends = await page.evaluate(() => (window as any).loginRecoverySends);
  expect(sends).toHaveLength(1);
  expect(JSON.stringify(sends)).toContain(Buffer.from('bytes retained through login expiry').toString('base64'));
  await attachProofPng(info, 'authenticated reload sends original attachment once', await page.screenshot());
});
