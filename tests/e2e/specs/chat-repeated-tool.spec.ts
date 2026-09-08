import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('preserves separate tool calls when the provider reuses an ID in later runs', async ({ app }, info) => {
  test.setTimeout(240_000);
  const page = app.page;
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  const id = await page.locator('[data-deck-column]').first().getAttribute('data-deck-column');
  const tile = page.locator(`[data-deck-column="${id}"]`);
  await tile.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  for (const run of [1, 2]) {
    await tile.getByRole('textbox').fill(`REPEAT_TOOL_${run}`);
    await tile.getByRole('textbox').press('Enter');
    await expect(tile.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    await tile.getByRole('button', { name: 'Approve Once', exact: true }).click();
    await expect(tile.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(run, { timeout: 90_000 });
    await expect(tile.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  }
  await expect(tile.getByText(/steps?.*1 command/)).toHaveCount(2);
  await attachProofPng(info, 'distinct repeated tool calls before reload', await app.captureScreenshot());
  await page.reload();
  await expect(tile.getByText(/steps?.*1 command/)).toHaveCount(2, { timeout: 90_000 });
  await expect(tile.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(2);
  await attachProofPng(info, 'distinct repeated tool calls after reload', await app.captureScreenshot());
});
