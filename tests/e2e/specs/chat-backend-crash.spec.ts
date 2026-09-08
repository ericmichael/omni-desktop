import { readFileSync } from 'node:fs';

import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('recovers chat after only the launcher backend dies, then retires the surviving old host', async ({
  app,
  mode,
}, testInfo) => {
  test.skip(mode !== 'server-local', 'Backend-only SIGKILL is a Linux server fixture');
  test.setTimeout(240_000);
  let page = app.page;
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input.fill('HOST_FIRST_MESSAGE_READY');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('HOST_FIRST_MESSAGE_READY', { timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  const before = app.inspectChatCleanup();
  expect(before.runtimePids.length).toBeGreaterThan(0);
  const id = before.tabs[0]!.id;
  const originalPage = page;
  page = await app.restart({ crash: true, backendOnly: true });
  expect(page).toBe(originalPage);
  await expect(page.getByRole('textbox', { name: 'How can I help you today?' })).toBeEditable({ timeout: 90_000 });
  await page.getByRole('textbox', { name: 'How can I help you today?' }).fill('after backend-only crash');
  await page.getByRole('textbox', { name: 'How can I help you today?' }).press('Enter');
  await expect(page.getByRole('log')).toContainText('after backend-only crash', { timeout: 90_000 });
  await expect(page.getByRole('log').getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(3, {
    timeout: 90_000,
  });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  await expect
    .poll(
      () =>
        before.runtimePids.every((pid) => {
          try {
            return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z ');
          } catch {
            return true;
          }
        }),
      { timeout: 30_000 }
    )
    .toBe(true);
  expect(app.inspectChatCleanup().tabs.some((tab) => tab.id === id)).toBe(true);
  await attachProofPng(
    testInfo,
    'conversation survives backend-only crash without orphan host',
    await app.captureScreenshot()
  );
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
  await expect.poll(() => app.inspectChatCleanup().tabs.some((tab) => tab.id === id)).toBe(false);
  await expect.poll(() => app.inspectChatCleanup().jobs, { timeout: 30_000 }).toEqual([]);
  expect(app.inspectChatCleanup().tabs.some((tab) => tab.id === id)).toBe(false);
});
