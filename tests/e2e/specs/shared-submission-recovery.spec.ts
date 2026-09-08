import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });
const input = (page: Page) => page.getByRole('textbox', { name: 'How can I help you today?' });

test('a retry during original attachment encoding accepts the message only once', async ({ app, mode }, info) => {
  test.skip(mode !== 'server-local', 'Two windows share the original composer attempt');
  test.setTimeout(180_000);
  const a = app.page;
  await input(a).waitFor({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('ENCODING_RETRY_SETUP');
  await input(a).press('Enter');
  await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'ENCODING_RETRY_SETUP', exact: true })
      .click();
    await expect(input(b)).toBeEditable();
    for (const page of [a, b]) {
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        (window as any).encodingSubmissionIds = [];
        WebSocket.prototype.send = function (data) {
          let frame;
          try {
            frame = JSON.parse(String(data));
          } catch {}
          if ((frame?.method === 'start_run' || frame?.method === 'queue_status') && frame.params?.submission_id) {
            const ids: string[] = (window as any).encodingSubmissionIds;
            if (!ids.includes(frame.params.submission_id)) {
              ids.push(frame.params.submission_id);
            }
          }
          return send.call(this, data);
        };
      });
    }
    await a.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (blob) {
        FileReader.prototype.readAsArrayBuffer = read;
        (window as any).releaseOriginalEncoding = () => read.call(this, blob);
      };
    });
    await input(a).fill('RETRY_DURING_ENCODING');
    await a
      .locator('.chat-input-footer')
      .filter({ has: input(a) })
      .locator('input[type="file"]')
      .setInputFiles({ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('same original bytes') });
    await input(a).press('Enter');
    await expect.poll(() => a.evaluate(() => typeof (window as any).releaseOriginalEncoding)).toBe('function');
    await b.getByRole('button', { name: 'Retry previous message', exact: true }).click();
    await expect(b.getByRole('log').getByText('RETRY_DURING_ENCODING', { exact: true })).toHaveCount(1);
    await expect(b.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    await expect(b.getByRole('button', { name: 'Retry previous message', exact: true })).toHaveCount(0);
    await a.evaluate(() => (window as any).releaseOriginalEncoding());
    await expect.poll(() => a.evaluate(() => (window as any).encodingSubmissionIds.length)).toBe(1);
    const first = await a.evaluate(() => (window as any).encodingSubmissionIds);
    const retry = await b.evaluate(() => (window as any).encodingSubmissionIds);
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual(expect.any(String));
    expect(first).toEqual(retry);
    for (const page of [a, b]) {
      await expect(page.getByRole('button', { name: 'Retry previous message', exact: true })).toHaveCount(0);
      await expect(page.getByRole('log').getByText('RETRY_DURING_ENCODING', { exact: true })).toHaveCount(1);
    }
    await attachProofPng(info, 'encoding and retry share one accepted submission', await a.screenshot());
  } finally {
    await b.close();
  }
});

async function holdRunReply(page: Page) {
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'start_run') {
        WebSocket.prototype.send = send;
        const receive = this.onmessage;
        this.onmessage = (event) => {
          let reply;
          try {
            reply = JSON.parse(String(event.data));
          } catch {}
          if (reply?.id === frame.id) {
            (window as any).releaseRunReply = () => {
              this.onmessage = receive;
              receive?.call(this, event);
            };
            return;
          }
          receive?.call(this, event);
        };
      }
      return send.call(this, data);
    };
  });
}

test('another window can recover an accepted send without its late reply erasing the next send', async ({
  app,
  mode,
}, info) => {
  test.skip(mode !== 'server-local', 'Two browser windows share one session and draft store');
  test.setTimeout(180_000);
  const a = app.page;
  await expect(input(a)).toBeVisible({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('SHARED_SEND_SETUP');
  await input(a).press('Enter');
  await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'SHARED_SEND_SETUP', exact: true })
      .click();
    await expect(b.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
    await holdRunReply(a);
    await input(a).fill('FIRST_ACCEPTED');
    await input(a).press('Enter');
    await expect.poll(() => a.evaluate(() => typeof (window as any).releaseRunReply)).toBe('function');
    await b.getByRole('button', { name: 'Retry previous message', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Retry previous message', exact: true })).toHaveCount(0);
    await expect(b.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    await holdRunReply(b);
    await input(b).fill('SECOND_ACCEPTED');
    await b
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second attachment bytes') });
    await input(b).press('Enter');
    await expect.poll(() => b.evaluate(() => typeof (window as any).releaseRunReply)).toBe('function');
    await a.evaluate(() => (window as any).releaseRunReply());
    await expect(a.getByText('Previous message: SECOND_ACCEPTED', { exact: true })).toBeVisible();
    const attachment = await a.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('omni-conversation-drafts-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows: any[] = await new Promise((resolve, reject) => {
          const request = db.transaction('drafts').objectStore('drafts').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const file = rows.find((row) => row.pendingInput?.text === 'SECOND_ACCEPTED')?.pendingInput.files[0];
        return file ? { name: file.name, text: await file.text() } : null;
      } finally {
        db.close();
      }
    });
    expect(attachment).toEqual({ name: 'second.txt', text: 'second attachment bytes' });
    await attachProofPng(info, 'newer send remains recoverable after older acknowledgment', await a.screenshot());
    await b.evaluate(() => (window as any).releaseRunReply());
    for (const page of [a, b]) {
      await expect(page.getByRole('button', { name: 'Retry previous message', exact: true })).toHaveCount(0);
      await expect(page.getByRole('log').getByText('FIRST_ACCEPTED', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('log').getByText('SECOND_ACCEPTED', { exact: true })).toHaveCount(1);
    }
  } finally {
    await b.close();
  }
});
