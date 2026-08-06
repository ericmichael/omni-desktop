import { expect, test } from 'tests/e2e/fixtures/test';
import { openSettings } from 'tests/e2e/support/app';
import { attachProofPng } from 'tests/e2e/support/proof';

test.describe('runtime policy settings', () => {
  test('describes, validates, writes, and resets layered policy through the real runtime', async ({
    app,
    mode,
  }, testInfo) => {
    test.skip(mode !== 'electron-local', 'Runtime Policy is backed by the Electron-local Omni runtime');
    test.setTimeout(300_000);

    const page = app.page;
    await openSettings(page);
    await page.getByRole('button', { name: 'Runtime Policy', exact: true }).click();

    const policy = page.locator('[aria-label="Runtime Policy"]');
    await expect(policy.getByText('Runtime policy', { exact: true })).toBeVisible({ timeout: 120_000 });

    await test.step('show server-described fields, provenance, and reload behavior', async () => {
      await expect(policy.getByText('Product name', { exact: true })).toBeVisible({ timeout: 120_000 });
      await expect(policy.getByText('Project layer', { exact: true }).first()).toBeVisible();
      await expect(policy.getByText(/Effective source: .*project\.yml/).first()).toBeVisible();
      await expect(policy.getByText('Safety mode', { exact: true })).toBeVisible();
      await expect(policy.getByText('Next session', { exact: true })).toBeVisible();
      await expect(policy.getByText('Read only', { exact: true })).toHaveCount(0);
    });

    await attachProofPng(testInfo, 'runtime policy real runtime', await app.captureScreenshot());

    const retention = policy.getByRole('spinbutton', { name: 'Audit retention (days)' });
    await expect(retention).toHaveValue('0');

    await test.step('validate and atomically write an isolated override', async () => {
      await retention.fill('1');
      await policy.getByRole('button', { name: 'Validate & save' }).click();
      await expect(policy.getByText('Runtime policy saved', { exact: true })).toBeVisible();
      await expect(retention).toHaveValue('1');
      await expect(policy.getByText('User layer', { exact: true }).first()).toBeVisible();
    });

    await test.step('reset the override to its inherited value', async () => {
      await policy.getByRole('button', { name: 'Reset Audit retention (days)' }).click();
      await expect(policy.getByText('Will reset to the inherited value when saved.')).toBeVisible();
      await policy.getByRole('button', { name: 'Validate & save' }).click();
      await expect(policy.getByText('Runtime policy saved', { exact: true })).toBeVisible();
      await expect(retention).toHaveValue('0');
    });
  });
});
