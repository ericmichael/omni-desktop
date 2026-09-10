import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const crash of [false, true]) {
  test(`retires orphaned approvals and questions after a ${crash ? 'crash' : 'graceful'} server restart`, async ({
    app,
    mode,
  }, testInfo) => {
    test.skip(mode !== 'server-local', 'This audit restarts the launcher server and its child agent runtime');
    test.setTimeout(240_000);
    let page = app.page;
    const input = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(input).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await input.fill('TILE_APPROVAL_A');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const columns = page.locator('[data-deck-column]');
    await expect(columns).toHaveCount(2);
    const ids = await columns.evaluateAll((els) => els.map((el) => el.getAttribute('data-deck-column')));
    const b = columns.nth(1);
    const picker = b.getByRole('button', { name: 'Workstation', exact: true });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    await b.getByRole('textbox', { name: 'How can I help you today?' }).fill('TILE_QUESTION_B');
    await b.getByRole('textbox', { name: 'How can I help you today?' }).press('Enter');
    await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible({ timeout: 90_000 });
    await attachProofPng(testInfo, 'pending before full server restart', await app.captureScreenshot());

    // Stops the isolated launcher process group (including its child agent),
    // then starts fresh processes using the same isolated on-disk profile.
    page = await app.restart({ crash });
    const restoredA = page.locator(`[data-deck-column="${ids[0]}"]`);
    const restoredB = page.locator(`[data-deck-column="${ids[1]}"]`);
    for (const column of [restoredA, restoredB]) {
      await expect(column.getByRole('textbox', { name: 'How can I help you today?' })).toBeEditable({
        timeout: 90_000,
      });
    }
    await expect(restoredA.getByRole('log')).toContainText('TILE_APPROVAL_A');
    await expect(restoredB.getByRole('log')).toContainText('TILE_QUESTION_B');
    await attachProofPng(testInfo, 'recovered after full server restart', await app.captureScreenshot());
    // A dead server-side waiter cannot support an actionable approval card.
    await expect(restoredB.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    const approve = restoredA.getByRole('button', { name: 'Approve Once', exact: true });
    await expect.soft(approve).toHaveCount(0);
    if (await approve.isVisible()) {
      await approve.click();
      // The decision cannot land; the card stays actionable and says nothing.
      await expect(approve).toBeEnabled();
      await expect(restoredA.getByRole('alert')).toHaveCount(0);
      await attachProofPng(testInfo, 'orphan approval cannot be resolved', await app.captureScreenshot());
    }
  });
}
