import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

async function holdCommand(page: Page, method: string) {
  await page.evaluate((method) => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.channel === 'store:chat-command' && frame.args?.[0]?.method === method) {
        WebSocket.prototype.send = send;
        (window as unknown as { releaseChatCommand: () => void }).releaseChatCommand = () => send.call(this, data);
        return;
      }
      send.call(this, data);
    };
  }, method);
}
async function releaseCommand(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as unknown as { releaseChatCommand?: () => void }).releaseChatCommand)
    )
    .toBe('function');
  await page.evaluate(() => {
    const target = window as unknown as { releaseChatCommand?: () => void };
    target.releaseChatCommand!();
    delete target.releaseChatCommand;
  });
}
async function newTile(page: Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chat', exact: true }).click();
}

test('concurrent windows retain new tiles and a stale reorder cannot restore an archived tile', async ({
  app,
  mode,
}, testInfo) => {
  test.skip(
    mode !== 'server-local',
    'Two browser windows share the launcher authority; Electron tile behavior has separate coverage.'
  );
  const a = app.page;
  await expect(a.getByRole('textbox', { name: 'How can I help you today?' })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await expect(b.getByRole('textbox', { name: 'How can I help you today?' })).toBeVisible({ timeout: 90_000 });
    await a.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const columnsA = a.locator('[data-deck-column]');
    const columnsB = b.locator('[data-deck-column]');
    await expect(columnsA).toHaveCount(1);
    await expect(columnsB).toHaveCount(1);
    await holdCommand(b, 'addTab');
    await newTile(b);
    await newTile(a);
    await expect(columnsA).toHaveCount(2);
    await releaseCommand(b);
    await expect(columnsA).toHaveCount(3);
    await expect(columnsB).toHaveCount(3);
    const ids = await columnsA.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-deck-column'))
    );
    expect(new Set(ids).size).toBe(3);
    await expect
      .poll(() =>
        columnsB.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-deck-column')))
      )
      .toEqual(ids);
    await attachProofPng(testInfo, 'both concurrent tile additions survive', await a.screenshot());

    await holdCommand(b, 'reorderTabs');
    await columnsB.nth(0).getByRole('button', { name: 'Reorder New chat', exact: true }).focus();
    await b.keyboard.press('Space');
    await b.keyboard.press('ArrowRight');
    await b.keyboard.press('Space');
    await columnsA.nth(0).getByRole('button', { name: 'Session menu', exact: true }).click();
    await a.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
    await expect(columnsA).toHaveCount(2);
    await releaseCommand(b);
    await expect(columnsB).toHaveCount(2);
    await expect(a.locator(`[data-deck-column="${ids[0]}"]`)).toHaveCount(0);
    await expect(b.locator(`[data-deck-column="${ids[0]}"]`)).toHaveCount(0);
    await attachProofPng(testInfo, 'stale reorder does not restore archived tile', await b.screenshot());
  } finally {
    await b.close();
  }
});
