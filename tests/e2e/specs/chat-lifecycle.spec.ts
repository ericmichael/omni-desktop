import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

async function dropAcceptedReply(page: Page, matchAnswer = false) {
  // Fault the real socket, including a connection opened before this test
  // acquired the page. No RPC handler or server response is mocked.
  await page.evaluate((matchAnswer) => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (
        (frame?.method === 'start_run' && frame.params?.prompt === 'LOST_RESPONSE_PROMPT') ||
        (frame?.method === 'enqueue_message' && frame.params?.content === 'LOST_RESPONSE_PROMPT') ||
        (matchAnswer && frame?.method === 'client_response' && frame.params?.result?.reply === 'Here is the image')
      ) {
        WebSocket.prototype.send = originalSend;
        const originalMessage = this.onmessage;
        this.onmessage = function (event) {
          let reply;
          try {
            reply = JSON.parse(String(event.data));
          } catch {}
          if (reply?.id === frame.id && (reply.result?.run_id || reply.result?.ok === true || reply.result === true)) {
            (window as unknown as { lostReplyDropped: boolean }).lostReplyDropped = true;
            this.close(4001, 'test lost reply');
            return;
          }
          originalMessage?.call(this, event);
        };
      }
      originalSend.call(this, data);
    };
  }, matchAnswer);
}

test('reconciles an accepted send after its RPC reply is lost', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await dropAcceptedReply(page);
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('Respond with exactly HOST_FIRST_MESSAGE_READY and nothing else.');
  await composer.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 240_000 });
  await composer.fill('LOST_RESPONSE_PROMPT');
  await composer.press('Enter');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { lostReplyDropped?: boolean }).lostReplyDropped))
    .toBe(true);
  // Once the socket is back the client asks the server once for that
  // submission's receipt. It completed, so the send counts as delivered:
  // nothing returns to the composer and the prompt appears exactly once.
  await expect(page.getByRole('log').getByText('LOST_RESPONSE_PROMPT', { exact: true })).toHaveCount(1, {
    timeout: 90_000,
  });
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 90_000 });
  await attachProofPng(testInfo, 'lost reply reconciled without duplicate prompt', await app.captureScreenshot());
});

test('delivers an attachment when replying to an agent question', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('ASK_WITH_IMAGE');
  await composer.press('Enter');
  await expect(page.getByText('Please attach the requested image', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
  await dropAcceptedReply(page, true);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'answer.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    ),
  });
  await composer.fill('Here is the image');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { lostReplyDropped?: boolean }).lostReplyDropped))
    .toBe(true);
  await expect(composer).toHaveValue('Here is the image');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('log').getByText('Here is the image', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ESCALATION_IMAGE_RECEIVED', { exact: true }).last()).toBeVisible({ timeout: 60_000 });
  await attachProofPng(testInfo, 'agent receives question reply image', await app.captureScreenshot());
});

test('restores unsent text and attachment bytes after a renderer restart', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('Respond with exactly HOST_FIRST_MESSAGE_READY and nothing else.');
  await composer.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 240_000 });
  await composer.fill('This draft survives restart');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'restart.txt', mimeType: 'text/plain', buffer: Buffer.from('preserved bytes') });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        return new Promise<boolean>((resolve) => {
          const request = indexedDB.open('omni-conversation-drafts-v1', 1);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('drafts', 'readonly');
            const rows = tx.objectStore('drafts').getAll();
            rows.onsuccess = () =>
              resolve(
                rows.result.some(
                  (draft) => draft.text === 'This draft survives restart' && draft.files?.[0]?.name === 'restart.txt'
                )
              );
            tx.oncomplete = () => db.close();
          };
        });
      })
    )
    .toBe(true);
  await page.reload();
  await page
    .getByRole('list', { name: 'Recents' })
    .getByRole('button', { name: /^Respond with exactly HOST_FIRST_MESSAGE_READY/ })
    .first()
    .click({ timeout: 90_000 });
  await page.getByRole('radio', { name: 'Focus', exact: true }).click();
  await expect(composer).toHaveValue('This draft survives restart');
  await expect(page.getByText('restart.txt', { exact: true })).toBeVisible();
  await attachProofPng(testInfo, 'draft and file restored after restart', await app.captureScreenshot());
});

test('keeps an in-flight reply and draft with their conversation while switching chats', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('WAIT_FOR_SESSION_A');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 240_000 });
  await composer.fill('Unsent draft belongs to A');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const focusLayout = page.getByRole('radio', { name: 'Focus', exact: true });
  if ((await focusLayout.getAttribute('aria-checked')) !== 'true') {
    await page.getByRole('button', { name: 'Focus New chat', exact: true }).click();
  }
  await expect(focusLayout).toHaveAttribute('aria-checked', 'true');
  await expect(composer).toHaveValue('');
  const workstation = page.getByRole('button', { name: 'Workstation', exact: true });
  if (await workstation.isVisible()) {
    await workstation.click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  }
  await composer.fill('PROMPT_FOR_SESSION_B');
  await composer.press('Enter');
  await expect(page.getByText('SESSION_B_REPLY', { exact: true }).last()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('log')).not.toContainText('SESSION_A_REPLY');
  await attachProofPng(testInfo, 'B displays only its own reply', await app.captureScreenshot());
  const recents = page.getByRole('list', { name: 'Recents' });
  await recents.getByRole('button', { name: 'WAIT_FOR_SESSION_A', exact: true }).click();
  await expect(page.getByText('SESSION_A_REPLY', { exact: true }).last()).toBeVisible({ timeout: 90_000 });
  await expect(composer).toHaveValue('Unsent draft belongs to A');
  await expect(page.getByRole('log')).not.toContainText('SESSION_B_REPLY');
  await attachProofPng(testInfo, 'A retains its late reply and draft', await app.captureScreenshot());
  await recents.getByRole('button', { name: 'PROMPT_FOR_SESSION_B', exact: true }).click();
  await expect(page.getByText('SESSION_B_REPLY', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('log')).not.toContainText('SESSION_A_REPLY');
});

test('keeps the chosen model and a follow-up draft across first-message startup', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByPlaceholder('How can I help you today?');
  await expect(composer).toBeVisible({ timeout: 90_000 });
  const model = page.getByTitle('Choose the model for this conversation');
  await expect(model).toBeEnabled({ timeout: 90_000 });
  await model.click();
  await page.getByRole('menuitemradio', { name: /GPT 5\.2 Mini E2E/ }).click();
  await expect(model).toContainText('GPT 5.2 Mini E2E');
  await attachProofPng(testInfo, 'model selectable before first message', await app.captureScreenshot());
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('Respond with exactly HOST_FIRST_MESSAGE_READY and nothing else.');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await composer.fill('This follow-up must survive startup');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft attachment') });
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 240_000 });
  await expect(composer).toHaveValue('This follow-up must survive startup');
  await expect(page.getByText('draft.txt', { exact: true })).toBeVisible();
  await expect(model).toContainText('GPT 5.2 Mini E2E');
  await attachProofPng(testInfo, 'draft and model survive startup', await app.captureScreenshot());
});

test('delivers an image queued during an active response', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const composer = page.getByPlaceholder('How can I help you today?');
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await composer.fill('WAIT_FOR_QUEUED_IMAGE');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'queued.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    ),
  });
  await composer.fill('Describe the queued image');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Up next', { exact: true })).toBeVisible();
  await attachProofPng(testInfo, 'image queued during active response', await app.captureScreenshot());
  await expect(page.getByText('QUEUED_IMAGE_RECEIVED', { exact: true }).last()).toBeVisible({ timeout: 60_000 });
  await attachProofPng(testInfo, 'queued image reached model', await app.captureScreenshot());
});
