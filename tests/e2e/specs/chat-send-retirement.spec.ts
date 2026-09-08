import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('archiving during attachment encoding never dispatches the retired send', async ({ app }, info) => {
  test.setTimeout(180_000);
  const page = app.page;
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await input.waitFor({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input.fill('RETIRE_UPLOAD_SETUP');
  await input.press('Enter');
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => {
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (blob) {
      FileReader.prototype.readAsArrayBuffer = read;
      (window as any).releaseUpload = () => read.call(this, blob);
    };
    (window as any).retiredSends = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'start_run' || frame?.method === 'enqueue_message') {
        (window as any).retiredSends.push(frame);
      }
      return send.call(this, data);
    };
  });
  await input.fill('DO_NOT_SEND_AFTER_ARCHIVE');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('retired bytes') });
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseUpload)).toBe('function');
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
  await expect(page.getByRole('log').filter({ hasText: 'RETIRE_UPLOAD_SETUP' })).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseUpload());
  // Readback proves the continuation settled and restored the unsent bytes.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open('omni-conversation-drafts-v1');
          r.onsuccess = () => resolve(r.result);
        });
        const rows: any[] = await new Promise((resolve) => {
          const r = db.transaction('drafts').objectStore('drafts').getAll();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        const row = rows.find((row) => row.text === 'DO_NOT_SEND_AFTER_ARCHIVE');
        return row?.files[0] ? await row.files[0].text() : null;
      })
    )
    .toBe('retired bytes');
  expect(await page.evaluate(() => (window as any).retiredSends)).toEqual([]);
  await attachProofPng(info, 'archive remains closed after delayed upload completes', await app.captureScreenshot());
});
