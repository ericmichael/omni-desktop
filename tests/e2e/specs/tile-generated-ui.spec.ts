import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('keeps generated plans and artifacts in their tile through updates and reconnect', async ({ app }, testInfo) => {
  test.setTimeout(360_000);
  const page = app.page;
  // Track real sockets so reconnect exercises the normal event replay path.
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    const sockets = new Set<WebSocket>();
    const interrupted = new Set<string>();
    (window as any).interruptedTiles = () => interrupted.size;
    WebSocket.prototype.send = function (data) {
      if (!sockets.has(this)) {
        const original = this.onmessage;
        this.onmessage = function (event) {
          original?.call(this, event);
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          const p = frame.params;
          if (
            frame.method === 'client_request' &&
            p?.function === 'ui.add_artifact' &&
            String(p.args?.content).endsWith('_updated') &&
            !interrupted.has(p.session_id)
          ) {
            interrupted.add(p.session_id);
            this.close(4001, 'interrupt active artifact update');
          }
        };
      }
      sockets.add(this);
      return send.call(this, data);
    };
    (window as any).openTileSockets = () =>
      [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN).length;
    (window as any).disconnectTileSockets = () => {
      const count = (window as any).openTileSockets();
      [...sockets].forEach((socket) => socket.close(4001, 'tile test'));
      return count;
    };
  });
  const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(inputs).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await inputs.fill('TILE_UI_A');
  await inputs.press('Enter');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  await expect(inputs).toHaveCount(2);
  const columns = page.locator('[data-deck-column]');
  const a = columns.nth(0);
  const b = columns.nth(1);
  const picker = b.getByRole('button', { name: 'Workstation', exact: true });
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  }
  await inputs.nth(1).fill('TILE_UI_B');
  await inputs.nth(1).press('Enter');
  for (const [column, id] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    await expect(column.getByText(`${id}_ARTIFACT_initial`, { exact: true })).toBeVisible({ timeout: 240_000 });
    await expect(column.getByText(`${id}_PLAN_initial`, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_ARTIFACT_initial`);
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_PLAN_initial`);
  }
  await attachProofPng(testInfo, 'separate initial plans and artifacts', await app.captureScreenshot());
  for (const input of [inputs.nth(0), inputs.nth(1)]) {
    await input.fill('UPDATE_TILE_UI');
    await input.press('Enter');
  }
  for (const [column, id] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    await expect(column.getByText(`${id}_ARTIFACT_updated`, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(column.getByText(`${id}_PLAN_updated`, { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(column.getByText(`${id}_ARTIFACT_initial`, { exact: true })).toHaveCount(0);
    await column.getByRole('button', { name: 'Maximize', exact: true }).click();
    await expect(column.getByText(`${id}_ARTIFACT_updated`, { exact: true })).toBeVisible();
    await attachProofPng(testInfo, `${id} artifact expanded within its tile`, await app.captureScreenshot());
    await column.getByRole('button', { name: 'Restore', exact: true }).click();
  }
  const connectionCount = await page.evaluate(() => (window as any).disconnectTileSockets());
  expect(connectionCount).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).openTileSockets()), { timeout: 90_000 })
    .toBe(connectionCount);
  await expect(inputs.nth(0)).toBeEditable({ timeout: 90_000 });
  await expect(inputs.nth(1)).toBeEditable({ timeout: 90_000 });
  for (const [column, id] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    await expect(column.getByText(`${id}_ARTIFACT_updated`, { exact: true })).toHaveCount(1);
    await expect(column.getByText(`${id}_PLAN_updated`, { exact: true }).first()).toBeVisible();
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_ARTIFACT_updated`);
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_PLAN_updated`);
  }
  await attachProofPng(testInfo, 'updated plans and artifacts after reconnect', await app.captureScreenshot());
  await expect.poll(() => page.evaluate(() => (window as any).interruptedTiles())).toBe(2);

  // A same-ID artifact in the other tile must never become the scroll target.
  await page.evaluate(() => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (this.hasAttribute('data-artifact-id')) {
        (window as any).artifactScrollOwner = this.closest('[data-deck-column]')?.getAttribute('data-deck-column');
      }
      original.call(this, options);
    };
  });
  const aId = await a.getAttribute('data-deck-column');
  const bId = await b.getAttribute('data-deck-column');
  await b.getByRole('button', { name: 'Toggle artifacts', exact: true }).click();
  await b.getByRole('button', { name: 'B artifact', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).artifactScrollOwner)).toBe(bId);
  await inputs.nth(0).fill('Focused draft A');
  await a.getByRole('button', { name: 'Reorder TILE_UI_A', exact: true }).focus();
  await page.keyboard.press('Control+e');
  await expect(a.getByRole('button', { name: 'Collapse column', exact: true })).toBeVisible();
  await expect(b.getByRole('button', { name: 'Expand column', exact: true })).toBeVisible();
  await page.keyboard.press('Control+e');
  await expect(a.getByRole('button', { name: 'Expand column', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Focus', exact: true }).click();
  await expect(inputs).toHaveValue('Focused draft A');
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Toggle artifacts', exact: true })).toBeVisible();
  await expect(b.getByRole('button', { name: 'Toggle artifacts', exact: true })).toBeVisible();
  await a.getByRole('button', { name: 'Reorder TILE_UI_A', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(columns.nth(1)).toHaveAttribute('data-deck-column', aId!);
  await expect(
    page.locator(`[data-deck-column="${aId}"]`).getByRole('button', { name: 'Toggle artifacts', exact: true })
  ).toBeVisible();
  await expect(
    page.locator(`[data-deck-column="${bId}"]`).getByRole('button', { name: 'Toggle artifacts', exact: true })
  ).toBeVisible();
  await attachProofPng(
    testInfo,
    'scoped navigation focus and reordered header controls',
    await app.captureScreenshot()
  );
  await page.reload();
  for (const [columnId, id] of [
    [aId, 'A'],
    [bId, 'B'],
  ] as const) {
    const column = page.locator(`[data-deck-column="${columnId}"]`);
    await expect(column.getByText(`${id}_ARTIFACT_updated`, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(column.getByText(`${id}_ARTIFACT_updated`, { exact: true })).toHaveCount(1);
    await expect(column.getByText(`${id}_PLAN_updated`, { exact: true }).first()).toBeVisible();
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_ARTIFACT_updated`);
    await expect(column).not.toContainText(`${id === 'A' ? 'B' : 'A'}_PLAN_updated`);
  }
  await attachProofPng(testInfo, 'plans and artifacts recovered after full reload', await app.captureScreenshot());
});
