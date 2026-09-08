import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const reload of [false, true]) {
  test(`surfaces a failed stop and lets the owner retry during approval${reload ? ' after reload' : ''}`, async ({
    app,
  }, testInfo) => {
    test.setTimeout(360_000);
    const page = app.page;
    const input = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(input).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await input.fill('TILE_APPROVAL_A');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 240_000 });
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const ownerId = await page
      .locator('[data-deck-column]')
      .filter({
        has: page.getByRole('button', { name: 'Approve Once', exact: true }),
      })
      .getAttribute('data-deck-column');
    const owner = page.locator(`[data-deck-column="${ownerId}"]`);
    if (reload) {
      await page.reload();
      await page
        .getByRole('list', { name: 'Recents' })
        .getByRole('button', { name: 'TILE_APPROVAL_A', exact: true })
        .click({ timeout: 90_000 });
      await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    }
    // Reject one outbound stop before it reaches the real server. The retry
    // goes through the real transport and must retire the actual pending run.
    await page.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let frame;
        try {
          frame = JSON.parse(String(data));
        } catch {}
        if (frame?.method === 'stop_run') {
          WebSocket.prototype.send = send;
          queueMicrotask(() =>
            this.onmessage?.call(
              this,
              new MessageEvent('message', {
                data: JSON.stringify({
                  jsonrpc: '2.0',
                  id: frame.id,
                  error: { code: -32603, message: 'Injected stop failure' },
                }),
              })
            )
          );
          return;
        }
        send.call(this, data);
      };
    });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(
      page.getByText('Could not stop the run: Injected stop failure. Please retry.', { exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
    await attachProofPng(testInfo, 'failed stop remains retryable', await app.captureScreenshot());
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
    // Boot can also create a fresh tile; assert the original owner's composer.
    await expect(owner.getByRole('textbox', { name: 'How can I help you today?' })).toBeEditable();
    await attachProofPng(testInfo, 'successful stop retires approval', await app.captureScreenshot());
  });
}
