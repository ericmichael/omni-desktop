import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const scenario of ['questions', 'active-close', 'approvals']) {
  test(`isolates tiles during ${scenario}`, async ({ app }, testInfo) => {
    test.setTimeout(360_000);
    const page = app.page;
    const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(inputs).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await inputs.fill(
      scenario === 'questions' ? 'TILE_QUESTION_A' : scenario === 'approvals' ? 'TILE_APPROVAL_A' : 'WAIT_FOR_SESSION_A'
    );
    await inputs.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 240_000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    await expect(inputs).toHaveCount(2);
    const columns = page.locator('[data-deck-column]');
    const aId = await columns.nth(0).getAttribute('data-deck-column');
    const bId = await columns.nth(1).getAttribute('data-deck-column');
    const a = page.locator(`[data-deck-column="${aId}"]`);
    const b = page.locator(`[data-deck-column="${bId}"]`);
    const picker = b.getByRole('button', { name: 'Workstation', exact: true });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    const inputA = a.getByRole('textbox', { name: 'How can I help you today?' });
    const inputB = b.getByRole('textbox', { name: 'How can I help you today?' });
    await inputB.fill(
      scenario === 'questions'
        ? 'TILE_QUESTION_B'
        : scenario === 'approvals'
          ? 'TILE_APPROVAL_B'
          : 'PROMPT_FOR_SESSION_B'
    );
    await inputB.press('Enter');
    if (scenario === 'questions') {
      await expect(a.getByText('Question for tile A', { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(a).not.toContainText('Question for tile B');
      await expect(b).not.toContainText('Question for tile A');
      await inputA.fill('Answer only A');
      await inputA.press('Enter');
      await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 90_000 });
      await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible();
      await inputA.fill('Surviving A draft');
      await b.getByRole('button', { name: 'Session menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
      await expect(b).toHaveCount(0);
      await expect(inputA).toHaveValue('Surviving A draft');
    } else if (scenario === 'approvals') {
      const approveA = a.getByRole('button', { name: 'Approve Once', exact: true });
      const approveB = b.getByRole('button', { name: 'Approve Once', exact: true });
      await expect(approveA).toBeVisible({ timeout: 90_000 });
      await expect(approveB).toBeVisible({ timeout: 90_000 });
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          let frame;
          try {
            frame = JSON.parse(String(data));
          } catch {}
          if (frame?.method === 'tool_approval_response' && frame.params?.decision === 'approve') {
            WebSocket.prototype.send = send;
            queueMicrotask(() =>
              this.onmessage?.call(
                this,
                new MessageEvent('message', {
                  data: JSON.stringify({
                    jsonrpc: '2.0',
                    id: frame.id,
                    error: { code: -32603, message: 'Injected approval transport failure' },
                  }),
                })
              )
            );
            return;
          }
          send.call(this, data);
        };
      });
      await approveA.click();
      // A failed decision leaves the card actionable with no message.
      await expect(approveA).toBeEnabled();
      await expect(approveB).toBeEnabled();
      await expect(a.getByRole('alert')).toHaveCount(0);
      await attachProofPng(
        testInfo,
        'approval error stays in A while B remains pending',
        await app.captureScreenshot()
      );
      await approveA.click();
      await expect(approveA).toHaveCount(0);
      await expect(approveB).toBeVisible();
      await b.getByRole('button', { name: 'Reject', exact: true }).click();
      await expect(approveB).toHaveCount(0);
    } else {
      await inputB.fill('Surviving B draft');
      await a.getByRole('button', { name: 'Reorder WAIT_FOR_SESSION_A', exact: true }).focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await expect(columns.nth(1)).toHaveAttribute('data-deck-column', aId!);
      await expect(a.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await a.getByRole('button', { name: 'Session menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
      await expect(a).toHaveCount(0);
      await expect(b.getByText('SESSION_B_REPLY', { exact: true }).last()).toBeVisible({ timeout: 90_000 });
      await expect(inputB).toHaveValue('Surviving B draft');
      await expect(b.getByRole('log')).not.toContainText('SESSION_A_REPLY');
    }
    await attachProofPng(testInfo, scenario, await app.captureScreenshot());
  });
}
