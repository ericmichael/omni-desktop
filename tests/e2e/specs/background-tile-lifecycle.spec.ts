import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

for (const scenario of ['stream', 'approval', 'artifact'] as const) {
  test(`background tile owns ${scenario} through focus, resize and native minimize`, async ({ app, mode }, info) => {
    test.setTimeout(240_000);
    const page = app.page;
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      const tracked = new WeakSet<WebSocket>();
      (window as any).backgroundEvents = [];
      WebSocket.prototype.send = function (data) {
        if (!tracked.has(this)) {
          tracked.add(this);
          this.addEventListener('message', (event) => {
            let frame;
            try {
              frame = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (
              ['message_output', 'client_request', 'tool_approval_requested'].includes(frame.method) &&
              frame.params?.session_id
            ) {
              (window as any).backgroundEvents.push({
                method: frame.method,
                session: frame.params.session_id,
                text: JSON.stringify(frame.params),
              });
            }
          });
        }
        return send.call(this, data);
      };
    });
    await page.reload();
    const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(inputs).toBeVisible({ timeout: 90_000 });
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    for (let index = 0; index < 2; index++) {
      if (index) {
        await page.getByRole('button', { name: 'New chat', exact: true }).click();
        await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
      }
      const column = page.locator('[data-deck-column]').nth(index);
      const workstation = column.getByRole('button', { name: 'Workstation', exact: true });
      if (await workstation.isVisible()) {
        await workstation.click();
        await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
      }
      await column.getByRole('textbox').fill(`BACKGROUND_${index}`);
      await column.getByRole('textbox').press('Enter');
      await expect(column.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
    }
    const a = page.locator('[data-deck-column]').nth(0);
    const b = page.locator('[data-deck-column]').nth(1);
    await b.getByRole('textbox').fill('independent background-check draft');
    const prompt =
      scenario === 'stream'
        ? 'SOAK_BACKGROUND WAIT_FOR_SESSION_A'
        : scenario === 'approval'
          ? 'TILE_APPROVAL_A'
          : 'TILE_UI_A';
    const marker =
      scenario === 'stream' ? 'SESSION_A_REPLY' : scenario === 'approval' ? 'TILE_APPROVAL_A' : 'A_ARTIFACT_initial';
    await a.getByRole('textbox').fill(`${prompt} BACKGROUND_LIFECYCLE_GATE`);
    await a.getByRole('textbox').press('Enter');
    await b.getByRole('textbox').click();
    await page.getByRole('radio', { name: 'Focus', exact: true }).click();
    await expect(inputs).toHaveValue('independent background-check draft');
    await app.resizeWindow(1100, 800);
    if (mode === 'electron-local') {
      await app.setMinimized(true);
    }
    try {
      app.releaseBackground();
      await expect
        .poll(
          () =>
            page.evaluate(
              (expected) =>
                (window as any).backgroundEvents.some((event: { text: string }) => event.text.includes(expected)),
              marker
            ),
          { timeout: 90_000 }
        )
        .toBe(true);
    } finally {
      if (mode === 'electron-local') {
        await app.setMinimized(false);
      }
    }
    await app.resizeWindow(1920, 1080);
    await expect(inputs).toHaveValue('independent background-check draft');
    await expect(page.getByText(marker, { exact: true })).not.toBeVisible();
    if (scenario === 'approval') {
      await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
    }
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    await a.scrollIntoViewIfNeeded();
    if (scenario === 'approval') {
      await expect(a.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
      await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
      await a.getByRole('button', { name: 'Approve Once', exact: true }).click();
      await expect(a.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    } else {
      await expect(a.getByText(marker, { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(b).not.toContainText(marker);
    }
    if (scenario === 'artifact') {
      await expect(a.getByText('A_PLAN_initial', { exact: true }).first()).toBeVisible();
      await a.getByRole('button', { name: 'Toggle artifacts', exact: true }).click();
      await a.getByRole('button', { name: 'A artifact', exact: true }).click();
      await expect(a.getByText(marker, { exact: true })).toBeVisible();
    }
    await expect(b.getByRole('textbox')).toHaveValue('independent background-check draft');
    await attachProofPng(info, `background ${scenario} retains its tile`, await app.captureScreenshot());
  });
}
