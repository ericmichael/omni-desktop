import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const interaction of ['question', 'approval'] as const) {
  test(`recovers two pending ${interaction}s through reconnect and reload`, async ({ app }, testInfo) => {
    test.setTimeout(360_000);
    const page = app.page;
    await page.evaluate(() => {
      const sockets = new Set<WebSocket>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        sockets.add(this);
        return send.call(this, data);
      };
      (window as any).openPendingSockets = () =>
        [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN).length;
      (window as any).disconnectPendingSockets = () => {
        const open = [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN);
        open.forEach((socket) => socket.close(4001, 'pending interaction recovery audit'));
        return open.length;
      };
    });
    const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(inputs).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await inputs.fill(`TILE_${interaction.toUpperCase()}_A`);
    await inputs.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 240_000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    await expect(inputs).toHaveCount(2);
    const columns = page.locator('[data-deck-column]');
    const ids = await columns.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-deck-column')));
    const a = page.locator(`[data-deck-column="${ids[0]}"]`);
    const b = page.locator(`[data-deck-column="${ids[1]}"]`);
    const picker = b.getByRole('button', { name: 'Workstation', exact: true });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    await inputs.nth(1).fill(`TILE_${interaction.toUpperCase()}_B`);
    await inputs.nth(1).press('Enter');
    const pending = (column: typeof a, id: string) =>
      interaction === 'question'
        ? column.getByText(`Question for tile ${id}`, { exact: true })
        : column.getByRole('button', { name: 'Approve Once', exact: true });
    const checkBoth = async () => {
      for (const [column, id, other] of [
        [a, 'A', 'B'],
        [b, 'B', 'A'],
      ] as const) {
        await expect(pending(column, id)).toBeVisible({ timeout: 90_000 });
        await expect(pending(column, id)).toHaveCount(1);
        await expect(column.getByRole('textbox', { name: 'How can I help you today?' })).toBeEditable();
        await expect(column.getByRole('log')).not.toContainText(`TILE_${interaction.toUpperCase()}_${other}`);
      }
    };
    await checkBoth();
    const disconnected = await page.evaluate(() => (window as any).disconnectPendingSockets());
    expect(disconnected).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).openPendingSockets()), { timeout: 90_000 })
      .toBe(disconnected);
    // A reload below is a second, separate boundary: reconnect retains the
    // controller's maps, whereas reload must reconstruct everything from the server.
    await expect(inputs.nth(0)).toBeEditable({ timeout: 90_000 });
    await checkBoth();
    await page.reload();
    await checkBoth();
    await a.scrollIntoViewIfNeeded();
    await attachProofPng(testInfo, `two pending ${interaction}s after reload`, await app.captureScreenshot());
    if (interaction === 'question') {
      const input = a.getByRole('textbox', { name: 'How can I help you today?' });
      // Let the server accept A's answer, then lose only its acknowledgement.
      // The retry after reconnect must consult A's receipt, not answer B.
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          let frame;
          try {
            frame = JSON.parse(String(data));
          } catch {}
          if (frame?.method === 'client_response' && frame.params?.result?.reply === 'Answer only A after reload') {
            WebSocket.prototype.send = send;
            const original = this.onmessage;
            this.onmessage = function (event) {
              let response;
              try {
                response = JSON.parse(String(event.data));
              } catch {}
              if (response?.id === frame.id) {
                (window as any).lostAnswerAcknowledgement = true;
                this.close(4001, 'lose accepted answer acknowledgement');
                return;
              }
              original?.call(this, event);
            };
          }
          return send.call(this, data);
        };
      });
      await input.fill('Answer only A after reload');
      await input.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).lostAnswerAcknowledgement)).toBe(true);
      await expect(input).toBeEditable({ timeout: 90_000 });
      await expect(input).toHaveValue('Answer only A after reload');
      await input.press('Enter');
      await expect(input).toHaveValue('', { timeout: 90_000 });
    } else {
      await pending(a, 'A').click();
    }
    await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 90_000 });
    await expect(pending(b, 'B')).toBeVisible();
    await page.reload();
    await expect(pending(b, 'B')).toBeVisible({ timeout: 90_000 });
    if (interaction === 'approval') {
      await expect(pending(a, 'A')).toHaveCount(0);
      await b.getByRole('button', { name: 'Reject', exact: true }).click();
      await expect(pending(b, 'B')).toHaveCount(0);
    } else {
      const input = b.getByRole('textbox', { name: 'How can I help you today?' });
      await input.fill('Answer only B after reload');
      await input.press('Enter');
    }
    await expect(b.getByText('HOST_FIRST_MESSAGE_READY', { exact: true }).last()).toBeVisible({ timeout: 90_000 });
    await expect(a.getByRole('log')).not.toContainText('Answer only B after reload');
    await expect(b.getByRole('log')).not.toContainText('Answer only A after reload');
    await a.scrollIntoViewIfNeeded();
    await attachProofPng(testInfo, `independently resolved ${interaction}s`, await app.captureScreenshot());
  });
}
