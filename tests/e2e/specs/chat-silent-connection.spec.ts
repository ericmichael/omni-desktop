import type { WebSocketRoute } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('recovers silently stalled RPC sockets while preserving each visible tile draft', async ({ app }, info) => {
  test.setTimeout(240_000);
  const page = app.page;
  const rpcSockets = new Set<WebSocketRoute>();
  const stalled = new Set<WebSocketRoute>();
  const recoveredEndpoints = new Set<string>();
  const endpoint = (socket: WebSocketRoute) => {
    const url = new URL(socket.url());
    url.search = '';
    return url.toString();
  };
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'initialize') {
        rpcSockets.add(socket);
      }
      if (frame?.method === 'initialized' && stalled.size && !stalled.has(socket)) {
        recoveredEndpoints.add(endpoint(socket));
      }
      if (!stalled.has(socket)) {
        server.send(data);
      }
    });
    server.onMessage((data) => {
      if (!stalled.has(socket)) {
        socket.send(data);
      }
    });
    socket.onClose((code, reason) => {
      rpcSockets.delete(socket);
      void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      rpcSockets.delete(socket);
      void socket.close({ code, reason });
    });
  });
  await page.reload();
  let input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input.fill('SILENT_CONNECTION_SETUP');
  await input.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  const first = page.locator('[data-deck-column]').nth(0);
  const second = page.locator('[data-deck-column]').nth(1);
  input = first.getByRole('textbox', { name: 'How can I help you today?' });
  const otherInput = second.getByRole('textbox', { name: 'How can I help you today?' });
  const picker = second.getByRole('button', { name: 'Workstation', exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  }
  await otherInput.fill('SILENT_SECOND_TILE');
  await otherInput.press('Enter');
  await expect(second.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(otherInput).toBeEditable();
  await otherInput.fill('independent second tile draft');
  await expect(input).toBeEditable();
  await input.fill('draft kept through silent connection failure');
  expect(rpcSockets.size).toBeGreaterThan(0);
  for (const socket of rpcSockets) {
    stalled.add(socket);
  }
  const stalledEndpoints = new Set([...stalled].map(endpoint));
  // Neither endpoint is closed by the fixture. Application frames disappear
  // in both directions; only the client's liveness check can trigger recovery.
  await expect
    .poll(() => [...stalledEndpoints].every((url) => recoveredEndpoints.has(url)), { timeout: 90_000 })
    .toBe(true);
  // Management and chat can use separate connections to the same endpoint.
  // A replacement URL alone is not proof that every original socket retired.
  await expect.poll(() => [...stalled].every((socket) => !rpcSockets.has(socket)), { timeout: 90_000 }).toBe(true);
  await expect(input).toBeEditable({ timeout: 90_000 });
  await expect(input).toHaveValue('draft kept through silent connection failure');
  await expect(otherInput).toBeEditable({ timeout: 90_000 });
  await expect(otherInput).toHaveValue('independent second tile draft');
  // Reconnects for different endpoints finish independently. Unlike press(),
  // clicking Send waits for the button to be actionable through hydration.
  await first.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    first.getByRole('log').getByText('draft kept through silent connection failure', { exact: true })
  ).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  await expect(second.getByRole('log')).not.toContainText('draft kept through silent connection failure');
  await expect(otherInput).toHaveValue('independent second tile draft');
  await attachProofPng(info, 'silent socket recovered with draft intact', await app.captureScreenshot());
});
