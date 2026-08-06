import { expect, test } from 'tests/e2e/fixtures/test';
import { openSettings } from 'tests/e2e/support/app';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'codex-account' });

test.describe('ChatGPT account ownership cutover', () => {
  test('keeps a canonical logout durable across an Electron restart', async ({ app, mode }, testInfo) => {
    test.skip(mode !== 'electron-local', 'Host-scoped ChatGPT credentials belong to the Electron-local runtime');
    test.setTimeout(300_000);

    expect(app.inspectCodexCredential()).toEqual({ exists: true, mode: 0o600 });

    await openSettings(app.page);
    await app.page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(app.page.getByText('Signed in to ChatGPT', { exact: true })).toBeVisible({ timeout: 120_000 });
    await attachProofPng(testInfo, 'ChatGPT account before canonical logout', await app.captureScreenshot());

    await app.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(app.page.getByText('Use your ChatGPT subscription', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => app.inspectCodexCredential()).toEqual({ exists: false, mode: null });
    await attachProofPng(testInfo, 'ChatGPT account after canonical logout', await app.captureScreenshot());

    const restarted = await app.restart();
    await openSettings(restarted);
    await restarted.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(restarted.getByText('Use your ChatGPT subscription', { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    expect(app.inspectCodexCredential()).toEqual({ exists: false, mode: null });
    await attachProofPng(testInfo, 'ChatGPT account stays signed out after restart', await app.captureScreenshot());
  });
});
