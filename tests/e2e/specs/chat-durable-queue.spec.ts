import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const dispatched of [false, true]) {
  test(`preserves ${dispatched ? 'uncertain dispatch without replay' : 'unstarted queued work behind unresolved runtime ownership'} after server death`, async ({
    app,
    mode,
  }, info) => {
    test.skip(mode !== 'server-local', 'Requires restarting the isolated server and agent together');
    test.setTimeout(240_000);
    let page = app.page;
    const input = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(input).toBeVisible({ timeout: 90_000 });
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const columnId = await page.locator('[data-deck-column]').first().getAttribute('data-deck-column');
    await page.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await input.fill('TILE_APPROVAL_A');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    const queued = dispatched ? 'TILE_APPROVAL_A QUEUE_UNCERTAIN' : 'QUEUE_SURVIVES_PROCESS_DEATH';
    await input.fill(queued);
    await input.press('Enter');
    await expect(page.getByText('Up next', { exact: true })).toBeVisible();
    if (dispatched) {
      await page.getByRole('button', { name: 'Approve Once', exact: true }).click();
      await expect(page.getByText('Up next', { exact: true })).toHaveCount(0, { timeout: 90_000 });
      await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    }
    await attachProofPng(info, 'queue before process death', await app.captureScreenshot());
    page = await app.restart({ crash: true });
    const restored = page.locator(`[data-deck-column="${columnId}"]`);
    await expect(restored.getByRole('textbox', { name: 'How can I help you today?' })).toBeEditable({
      timeout: 90_000,
    });
    // The queued message survives the crash and is listed plainly: no
    // "uncertain" wording, and cancel is always available.
    await expect(restored.getByText('Up next', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(restored.getByRole('button', { name: 'Cancel queued message' })).toBeEnabled();
    await expect(restored.getByRole('alert')).toHaveCount(0);
    await expect(restored.getByText(/Dispatch outcome unknown|Waiting for the previous runtime/)).toHaveCount(0);
    if (dispatched) {
      await expect(restored.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
      await expect(restored.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    } else {
      await expect(restored.getByRole('log').getByText(queued, { exact: true })).toHaveCount(0);
    }
    const other = page.locator(`[data-deck-column]:not([data-deck-column="${columnId}"])`);
    await expect(other).toHaveCount(1);
    await expect(other.getByText(queued, { exact: true })).toHaveCount(0);
    await expect(other.getByText('Up next', { exact: true })).toHaveCount(0);
    await attachProofPng(info, 'durable queue after process death', await app.captureScreenshot());
    await page.reload();
    await expect(restored.getByText('Up next', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(restored.getByRole('alert')).toHaveCount(0);
    if (dispatched) {
      await expect(restored.getByRole('log').getByText(queued, { exact: true })).toHaveCount(1);
    } else {
      await expect(restored.getByRole('log').getByText(queued, { exact: true })).toHaveCount(0);
      await restored.getByRole('button', { name: 'Cancel queued message' }).click();
      await expect(restored.getByText('Up next', { exact: true })).toHaveCount(0);
    }
  });
}
