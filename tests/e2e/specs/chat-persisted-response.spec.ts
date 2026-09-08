import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('persisted response appears once in its own tile without its stream message', async ({ app }, info) => {
  test.setTimeout(240_000);
  const page = app.page;
  let suppressed = 0;
  let providerUpdates = 0;
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'item_updated' && frame.params?.kind === 'agent_message') {
        providerUpdates++;
      }
      if (frame?.method === 'message_output' && frame.params?.content === 'SESSION_A_REPLY') {
        suppressed++;
        // Omit only the transcript notification, keeping the sequence slot
        // as a token so transport gap recovery cannot mask this regression.
        // The backend unit test separately proves real SDK event loss.
        socket.send(JSON.stringify({ ...frame, method: 'token', params: { ...frame.params, content: '' } }));
      } else {
        socket.send(data);
      }
    });
  });
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'How can I help you today?' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    if (index) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    }
    const column = page.locator('[data-deck-column]').nth(index);
    const workstation = column.getByRole('button', { name: 'Workstation', exact: true });
    if (await workstation.isVisible()) {
      await workstation.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    await column.getByRole('textbox').fill(`PERSISTENCE_SETUP_${index}`);
    await column.getByRole('textbox').press('Enter');
    await expect(column.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(column.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    await expect(column.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(1);
  }
  const a = page.locator('[data-deck-column]').nth(0);
  const b = page.locator('[data-deck-column]').nth(1);
  await b.getByRole('textbox').fill('independent persistence-check draft');
  const updatesBefore = providerUpdates;
  await a.getByRole('textbox').fill('SOAK_PERSISTENCE WAIT_FOR_SESSION_A');
  await a.getByRole('textbox').press('Enter');
  await expect(a.getByText('SESSION_A_REPLY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(a.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  expect(suppressed).toBeGreaterThan(0);
  expect(providerUpdates).toBeGreaterThan(updatesBefore);
  await expect(a.getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(1);
  await expect(b.getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(0);
  await expect(b.getByRole('textbox')).toHaveValue('independent persistence-check draft');
  await attachProofPng(info, 'persisted-response-owning-tile', await app.captureScreenshot());
  await page.reload();
  await expect(a.getByText('SESSION_A_REPLY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(a.getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(1);
  await expect(b.getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(0);
  await expect(b.getByRole('textbox')).toHaveValue('independent persistence-check draft');
});
