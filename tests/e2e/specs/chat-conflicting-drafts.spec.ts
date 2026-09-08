import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });
const input = (page: Page) => page.getByRole('textbox', { name: 'How can I help you today?' });

test('a competing send is retained for explicit retry instead of taking the active claim', async ({
  app,
  mode,
}, info) => {
  test.skip(mode !== 'server-local', 'Shared browser storage across two windows');
  test.setTimeout(180_000);
  const a = app.page;
  await input(a).waitFor({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('COMPETING_SEND_SETUP');
  await input(a).press('Enter');
  await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await a.context().addInitScript(() => {
    const Channel = BroadcastChannel;
    window.BroadcastChannel = class extends Channel {
      constructor(name: string) {
        super(name);
        if (name === 'omni-conversation-drafts-v1') {
          this.addEventListener('message', (event) => event.stopImmediatePropagation());
        }
      }
    };
  });
  await a.reload();
  await a
    .getByRole('list', { name: 'Recents' })
    .getByRole('button', { name: 'COMPETING_SEND_SETUP', exact: true })
    .click();
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'COMPETING_SEND_SETUP', exact: true })
      .click();
    await expect(input(b)).toBeEditable();
    await input(a).fill('FIRST_CONCURRENT');
    await a
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first bytes') });
    await input(b).fill('SECOND_CONCURRENT');
    await a.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (blob) {
        FileReader.prototype.readAsArrayBuffer = read;
        (window as any).releaseFirstUpload = () => read.call(this, blob);
      };
    });
    await input(a).press('Enter');
    await expect.poll(() => a.evaluate(() => typeof (window as any).releaseFirstUpload)).toBe('function');
    await input(b).press('Enter');
    await expect(b.getByText('Other draft: SECOND_CONCURRENT', { exact: true })).toBeVisible();
    await expect(b.getByRole('log').getByText('SECOND_CONCURRENT', { exact: true })).toHaveCount(0);
    await a.evaluate(() => (window as any).releaseFirstUpload());
    await expect(a.getByRole('log').getByText('FIRST_CONCURRENT', { exact: true })).toHaveCount(1);
    await expect(a.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    await b.reload();
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'COMPETING_SEND_SETUP', exact: true })
      .click();
    const saved = b.getByRole('alert').filter({ hasText: 'Other draft: SECOND_CONCURRENT' });
    await saved.getByRole('button', { name: 'Restore other draft', exact: true }).click();
    await expect(input(b)).toHaveValue('SECOND_CONCURRENT');
    await attachProofPng(info, 'losing concurrent submission survives reload', await b.screenshot());
    await input(b).press('Enter');
    for (const page of [a, b]) {
      await expect(page.getByRole('log').getByText('FIRST_CONCURRENT', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('log').getByText('SECOND_CONCURRENT', { exact: true })).toHaveCount(1);
    }
  } finally {
    await b.close();
  }
});

test('preserves competing drafts and attachment bytes across windows and reload', async ({ app, mode }, info) => {
  test.skip(mode !== 'server-local', 'Shared browser storage across two windows');
  test.setTimeout(180_000);
  const a = app.page;
  await input(a).waitFor({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('DRAFT_CONFLICT_SETUP');
  await input(a).press('Enter');
  await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    // A suspended/background window may not receive the broadcast before editing.
    await b.addInitScript(() => {
      const Channel = BroadcastChannel;
      window.BroadcastChannel = class extends Channel {
        constructor(name: string) {
          super(name);
          if (name === 'omni-conversation-drafts-v1') {
            this.addEventListener('message', (event) => event.stopImmediatePropagation());
          }
        }
      };
    });
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'DRAFT_CONFLICT_SETUP', exact: true })
      .click();
    await expect(input(b)).toBeEditable();
    await input(a).fill('Draft from A');
    await a
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'A.txt', mimeType: 'text/plain', buffer: Buffer.from('A bytes') });
    // Wait for the attachment checkpoint before the stale window writes.
    await expect
      .poll(() =>
        a.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve) => {
            const r = indexedDB.open('omni-conversation-drafts-v1');
            r.onsuccess = () => resolve(r.result);
          });
          const rows: any[] = await new Promise((resolve) => {
            const r = db.transaction('drafts').objectStore('drafts').getAll();
            r.onsuccess = () => resolve(r.result);
          });
          db.close();
          return rows.some((row) => row.text === 'Draft from A' && row.files[0]?.name === 'A.txt');
        })
      )
      .toBe(true);
    await input(b).fill('Draft from B');
    await expect(b.getByText('Other draft: Draft from A', { exact: true })).toBeVisible();
    await b.reload();
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'DRAFT_CONFLICT_SETUP', exact: true })
      .click();
    await expect(input(b)).toHaveValue('Draft from B');
    await b.getByRole('button', { name: 'Restore other draft', exact: true }).click();
    await expect(input(b)).toHaveValue('Draft from A');
    await expect(b.getByText('A.txt', { exact: true })).toBeVisible();
    await expect(b.getByText('Other draft: Draft from B', { exact: true })).toBeVisible();
    await attachProofPng(info, 'both conflicting drafts survive reload and restore', await b.screenshot());
    await b.evaluate(() => {
      const send = WebSocket.prototype.send;
      (window as any).restoredAttachmentSends = [];
      WebSocket.prototype.send = function (data) {
        let frame;
        try {
          frame = JSON.parse(String(data));
        } catch {}
        if (frame?.method === 'start_run' && frame.params?.prompt === 'Draft from A') {
          (window as any).restoredAttachmentSends.push(frame.params);
        }
        return send.call(this, data);
      };
    });
    await input(b).press('Enter');
    await expect(b.getByRole('log')).toContainText('Draft from A');
    await expect(b.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    const sends = await b.evaluate(() => (window as any).restoredAttachmentSends);
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0])).toContain(Buffer.from('A bytes').toString('base64'));
    await b.getByRole('button', { name: 'Restore other draft', exact: true }).click();
    await expect(input(b)).toHaveValue('Draft from B');
    await input(b).press('Enter');
    for (const page of [a, b]) {
      await expect(page.getByRole('log').getByText('Draft from A', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('log').getByText('Draft from B', { exact: true })).toHaveCount(1);
    }
  } finally {
    await b.close();
  }
});
