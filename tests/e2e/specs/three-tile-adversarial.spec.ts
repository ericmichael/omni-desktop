import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('isolates three mixed tiles through seeded layout churn, duplicate events, reconnect and uploaded drafts', async ({
  app,
}, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  await page.evaluate(() => {
    const sockets = new Set<WebSocket>();
    const originalSend = WebSocket.prototype.send;
    (window as any).duplicateCount = 0;
    WebSocket.prototype.send = function (data) {
      if (!sockets.has(this)) {
        sockets.add(this);
        const receive = this.onmessage;
        this.onmessage = function (event) {
          receive?.call(this, event);
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (frame.method && typeof frame.params?.seq === 'number') {
            (window as any).duplicateCount++;
            // Delayed stale deliveries must not duplicate transcript/tool state.
            setTimeout(() => receive?.call(this, event), 15);
          }
        };
      }
      return originalSend.call(this, data);
    };
    (window as any).disconnectAuditSockets = () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(4001, 'three-tile audit');
        }
      }
    };
  });
  const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(inputs).toBeVisible({ timeout: 90_000 });
  const prompts = ['TILE_UI_A WAIT_FOR_SESSION_A', 'TILE_QUESTION_B', 'TILE_APPROVAL_C'];
  for (let index = 0; index < 3; index++) {
    if (index > 0) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    }
    await expect(inputs).toHaveCount(index + 1);
    const column = page.locator('[data-deck-column]').nth(index);
    const picker = column.getByRole('button', { name: 'Workstation', exact: true });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    await inputs.nth(index).fill(prompts[index]!);
    await inputs.nth(index).press('Enter');
  }
  const ids = await page
    .locator('[data-deck-column]')
    .evaluateAll((elements) => elements.map((el) => el.getAttribute('data-deck-column')));
  const columns = ids.map((id) => page.locator(`[data-deck-column="${id}"]`));
  const [a, b, c] = columns;
  await expect(a!.getByText('A_ARTIFACT_initial', { exact: true })).toBeVisible({ timeout: 240_000 });
  await expect(b!.getByText('Question for tile B', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(c!.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
  for (let index = 0; index < 3; index++) {
    const column = columns[index]!;
    await column.getByRole('textbox').fill(`Owned draft ${index}`);
    await column
      .locator('input[type="file"]')
      .setInputFiles({ name: `tile-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Only tile ${index}`) });
  }
  let seed = 0x514c;
  for (let step = 0; step < 18; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = seed % 3;
    const column = columns[index]!;
    // focus() silently does nothing on a disabled reconnecting composer.
    // A real user cannot select that field until the connection is ready.
    await expect(async () => {
      await expect(column.getByRole('textbox')).toBeEditable();
      // Selection is a user action: focus() can silently no-op when hydration
      // disables the field between the readiness check and the focus call.
      await column.getByRole('textbox').click();
      await expect(column.getByRole('textbox')).toBeFocused();
    }).toPass({ timeout: 90_000 });
    if (step % 3 === 0) {
      await page.getByRole('radio', { name: 'Focus', exact: true }).click();
      await expect(inputs).toHaveValue(`Owned draft ${index}`);
      await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    } else if (step % 3 === 1) {
      const handle = column.getByRole('button', { name: /^Reorder / });
      await handle.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press(index % 2 ? 'ArrowLeft' : 'ArrowRight');
      await page.keyboard.press('Space');
    } else {
      await page.evaluate(() => (window as any).disconnectAuditSockets());
    }
    for (let owner = 0; owner < 3; owner++) {
      await expect(columns[owner]!.getByRole('textbox')).toHaveValue(`Owned draft ${owner}`);
      await expect(columns[owner]!.getByText(`tile-${owner}.txt`, { exact: true }).first()).toBeVisible();
    }
  }
  expect(await page.evaluate(() => (window as any).duplicateCount)).toBeGreaterThan(0);
  await page.context().setOffline(true);
  try {
    await page.evaluate(() => (window as any).disconnectAuditSockets());
    for (const column of columns) {
      await expect(column.getByRole('textbox')).toBeDisabled({ timeout: 30_000 });
    }
  } finally {
    await page.context().setOffline(false);
  }
  for (let owner = 0; owner < 3; owner++) {
    await expect(columns[owner]!.getByRole('textbox')).toBeEditable({ timeout: 90_000 });
    await expect(columns[owner]!.getByRole('textbox')).toHaveValue(`Owned draft ${owner}`);
  }
  for (const column of columns) {
    await expect(column.getByTitle('Choose the model for this conversation', { exact: true })).toContainText(
      'GPT 5.2 E2E'
    );
    await expect(column.getByTitle('Choose reasoning effort for this conversation', { exact: true })).toBeVisible();
    await expect(column.getByTitle('Approvals and task checks for this conversation', { exact: true })).toBeVisible();
  }
  // Questions retain the running phase; approval waits have their own paused
  // phase. The existing control policy locks only thinking/running phases.
  await expect(b!.getByTitle('Choose the model for this conversation', { exact: true })).toBeDisabled();
  await expect(c!.getByTitle('Choose the model for this conversation', { exact: true })).toBeEnabled();
  await expect(a!.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(a!.getByTitle('Choose the model for this conversation', { exact: true })).toBeEnabled();
  await expect(a!.getByText('A_ARTIFACT_initial', { exact: true })).toBeVisible();
  await expect(b!.getByText('Question for tile B', { exact: true })).toBeVisible();
  await expect(c!.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
  await attachProofPng(testInfo, 'three tiles recovered after offline transport', await app.captureScreenshot());
  await page.reload();
  for (let owner = 0; owner < 3; owner++) {
    await expect(columns[owner]!.getByRole('textbox')).toHaveValue(`Owned draft ${owner}`, { timeout: 90_000 });
    await expect(columns[owner]!.getByText(`tile-${owner}.txt`, { exact: true }).first()).toBeVisible();
    for (let other = 0; other < 3; other++) {
      if (other !== owner) {
        await expect(columns[owner]!.getByRole('log')).not.toContainText(prompts[other]!);
      }
    }
  }
  await expect(a!.getByText('A_ARTIFACT_initial', { exact: true })).toHaveCount(1);
  await expect(a!.getByText('A_PLAN_initial', { exact: true }).first()).toBeVisible();
  await expect(b!.getByText('Question for tile B', { exact: true })).toBeVisible();
  await expect(c!.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
  // Boot intentionally opens a fresh blank column. Capture each original
  // owner separately too, so horizontal overflow cannot hide proof of B.
  for (let owner = 0; owner < 3; owner++) {
    await columns[owner]!.scrollIntoViewIfNeeded();
    await attachProofPng(
      testInfo,
      `recovered owner ${owner} content and uploaded draft`,
      await columns[owner]!.screenshot()
    );
  }
  await attachProofPng(
    testInfo,
    'three independent tiles after seeded faults and reload',
    await app.captureScreenshot()
  );
  await c!.getByRole('button', { name: 'Approve Once', exact: true }).click();
  await expect(c!.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
  await expect(b!.getByText('Question for tile B', { exact: true })).toBeVisible();
});
