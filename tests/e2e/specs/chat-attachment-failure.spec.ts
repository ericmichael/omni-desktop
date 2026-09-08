import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('retains an aborted attachment across reload and sends its bytes once on retry', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input.fill('Respond with exactly HOST_FIRST_MESSAGE_READY and nothing else.');
  await input.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 240_000 });
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function () {
      FileReader.prototype.readAsArrayBuffer = read;
      queueMicrotask(() => this.onabort?.call(this, new ProgressEvent('abort')));
    };
  });
  await input.fill('ATTACHMENT_RETRY');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('original attachment bytes') });
  await input.press('Enter');
  await expect(
    page.getByText('Reading attachment "retained.txt" was cancelled. Please retry.', { exact: true })
  ).toBeVisible();
  await expect(input).toHaveValue('ATTACHMENT_RETRY');
  await expect(page.getByText('retained.txt', { exact: true })).toBeVisible();
  await attachProofPng(testInfo, 'aborted read retains original draft and attachment', await app.captureScreenshot());
  await page.reload();
  await page
    .getByRole('list', { name: 'Recents' })
    .getByRole('button', { name: /^Respond with exactly HOST_FIRST_MESSAGE_READY/ })
    .first()
    .click({ timeout: 90_000 });
  await page.getByRole('radio', { name: 'Focus', exact: true }).click();
  await expect(input).toHaveValue('ATTACHMENT_RETRY');
  await expect(page.getByText('retained.txt', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    (window as any).attachmentSends = [];
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'start_run' && frame.params?.prompt === 'ATTACHMENT_RETRY') {
        (window as any).attachmentSends.push(frame.params);
      }
      send.call(this, data);
    };
  });
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('ATTACHMENT_RETRY');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  const sends = await page.evaluate(() => (window as any).attachmentSends);
  expect(sends).toHaveLength(1);
  expect(JSON.stringify(sends[0])).toContain(Buffer.from('original attachment bytes').toString('base64'));
  await expect(input).toHaveValue('');
  await attachProofPng(testInfo, 'retry sends retained attachment once', await app.captureScreenshot());
});

test('releases image preview blob URLs after repeated draft edits and removal', async ({ app }, testInfo) => {
  const page = app.page;
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const live = new Set<string>();
    (window as any).livePreviewCount = () => live.size;
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob instanceof File && blob.type.startsWith('image/')) {
        live.add(url);
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4m8AAAAASUVORK5CYII=',
      'base64'
    ),
  });
  for (let i = 0; i < 20; i++) {
    await input.fill(`Draft revision ${i}`);
  }
  await expect.poll(() => page.evaluate(() => (window as any).livePreviewCount())).toBe(1);
  await attachProofPng(testInfo, 'one live image preview after repeated edits', await app.captureScreenshot());
  await page.getByRole('button', { name: 'Remove preview.png', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).livePreviewCount())).toBe(0);
});
