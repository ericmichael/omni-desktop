import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('archives one active tile without stopping its neighbor, including a lost archive reply', async ({
  app,
  mode,
}, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(inputs).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await inputs.fill('TILE_APPROVAL_A');
  await inputs.press('Enter');
  await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 240_000 });
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  const ownerId = await page.locator('[data-deck-column]').first().getAttribute('data-deck-column');
  const original = app.inspectChatCleanup().tabs.find((tab) => tab.id === ownerId)!;
  const a = page.locator(`[data-deck-column="${ownerId}"]`);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(inputs).toHaveCount(2);
  const b = page
    .locator('[data-deck-column]')
    .filter({ hasNot: page.getByRole('log').filter({ hasText: 'TILE_APPROVAL_A' }) });
  const picker = b.getByRole('button', { name: 'Workstation', exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  }
  await b.getByRole('textbox', { name: 'How can I help you today?' }).fill('TILE_APPROVAL_B');
  await b.getByRole('textbox', { name: 'How can I help you today?' }).press('Enter');
  await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
  if (mode === 'server-local') {
    await page.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let frame;
        try {
          frame = JSON.parse(String(data));
        } catch {}
        if (frame?.type === 'invoke') {
          (window as any).managementSocket = this;
        }
        if (frame?.channel === 'store:chat-command' && frame.args?.[0]?.method === 'archiveTab') {
          const message = this.onmessage;
          this.onmessage = function (event) {
            let reply;
            try {
              reply = JSON.parse(String(event.data));
            } catch {}
            if (reply?.id === frame.id) {
              (window as any).archiveReplyDropped = true;
              this.close(4001, 'lost archive reply');
              return;
            }
            message?.call(this, event);
          };
        }
        send.call(this, data);
      };
    });
  }
  await a.getByRole('button', { name: 'Session menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
  await expect(a).toHaveCount(0, { timeout: 90_000 });
  await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No archived sessions');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'TILE_APPROVAL_A', exact: true }).click();
  await expect
    .poll(() => app.inspectChatCleanup().tabs.find((tab) => tab.sessionId === original.sessionId)?.id)
    .not.toBeUndefined();
  const reopened = app.inspectChatCleanup().tabs.find((tab) => tab.sessionId === original.sessionId)!;
  expect(reopened.id).not.toBe(original.id);
  expect(reopened.snapshotRef).not.toBe(original.snapshotRef);
  await expect(page.locator(`[data-deck-column="${reopened.id}"]`).getByRole('log')).toContainText('TILE_APPROVAL_A');
  const restored = page.locator(`[data-deck-column="${reopened.id}"]`);
  await expect(restored.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
  await expect(restored.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
  if (mode === 'server-local') {
    await expect.poll(() => page.evaluate(() => (window as any).archiveReplyDropped), { timeout: 90_000 }).toBe(true);
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const socket: WebSocket | undefined = (window as any).managementSocket;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return 'connecting';
            }
            return new Promise<string>((resolve) => {
              const requestId = -Date.now();
              const done = (value: string) => {
                clearTimeout(timer);
                socket.removeEventListener('message', receive);
                resolve(value);
              };
              const receive = (event: MessageEvent) => {
                const response = JSON.parse(String(event.data));
                if (response.id === requestId) {
                  done(response.result?.type ?? 'unknown');
                }
              };
              const timer = setTimeout(() => done('timeout'), 2000);
              socket.addEventListener('message', receive);
              socket.send(
                JSON.stringify({ type: 'invoke', id: requestId, channel: 'agent-process:get-status', args: [id] })
              );
            });
          }, ownerId),
        { timeout: 90_000 }
      )
      .toBe('uninitialized');
  }
  await attachProofPng(
    testInfo,
    'restored tile has no stale approval while neighbor awaits approval',
    await app.captureScreenshot()
  );
  await b.getByRole('button', { name: 'Approve Once', exact: true }).click();
  await expect(b.getByRole('log')).toContainText('HOST_FIRST_MESSAGE_READY', { timeout: 90_000 });
  await restored.getByRole('textbox', { name: 'How can I help you today?' }).fill('Continue the restored conversation');
  await restored.getByRole('textbox', { name: 'How can I help you today?' }).press('Enter');
  await expect(restored.getByRole('log')).toContainText('HOST_FIRST_MESSAGE_READY', { timeout: 90_000 });
  await expect(restored.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
  await attachProofPng(testInfo, 'restored conversation runs again', await app.captureScreenshot());
});
