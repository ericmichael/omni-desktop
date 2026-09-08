import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('large persisted histories stay isolated while scrolling, streaming and switching tiles', async ({
  app,
}, info) => {
  test.setTimeout(360_000);
  const page = app.page;
  await page.addInitScript(() => {
    const sockets = new Map<string, WebSocket>();
    const send = WebSocket.prototype.send;
    let next = 0;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.params?.session_id && frame.method === 'queue_status') {
        sockets.set(frame.params.session_id, this);
      }
      return send.call(this, data);
    };
    (window as any).historyAudit = {
      sessions: () => [...sockets.keys()],
      call: (session: string, method: string, params: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          const socket = sockets.get(session)!;
          const id = `history-audit-${++next}`;
          const timer = setTimeout(() => {
            socket.removeEventListener('message', receive);
            reject(new Error(`Audit RPC timed out: ${method}`));
          }, 30_000);
          const receive = (event: MessageEvent) => {
            let frame;
            try {
              frame = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (frame.id !== id) {
              return;
            }
            clearTimeout(timer);
            socket.removeEventListener('message', receive);
            if (frame.error) {
              reject(new Error(frame.error.message));
            } else {
              resolve(frame.result);
            }
          };
          socket.addEventListener('message', receive);
          send.call(socket, JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, session_id: session } }));
        }),
    };
  });
  await page.reload();
  const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(inputs).toBeVisible({ timeout: 90_000 });
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    if (i) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    }
    const column = page.locator('[data-deck-column]').nth(i);
    const picker = column.getByRole('button', { name: 'Workstation', exact: true });
    if (await picker.isVisible()) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    }
    await inputs.nth(i).fill(`LARGE_HISTORY_${i}`);
    await inputs.nth(i).press('Enter');
    await expect(column.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  }
  const sessions = await page.evaluate(() => (window as any).historyAudit.sessions() as string[]);
  expect(sessions).toHaveLength(2);
  // Seed through the real session RPC/store, not synthetic renderer snapshots.
  // trigger_run:false adds history without making model calls.
  for (let owner = 0; owner < 2; owner++) {
    await page.evaluate(
      async ({ session, owner }) => {
        const audit = (window as any).historyAudit;
        for (let index = 0; index < 750; index++) {
          await audit.call(session, 'enqueue_message', {
            content: `HISTORY_${owner}_${String(index).padStart(4, '0')}`,
            role: 'user',
            trigger_run: false,
          });
        }
      },
      { session: sessions[owner]!, owner }
    );
    await expect
      .poll(
        () =>
          page.evaluate(async (session) => {
            const result = await (window as any).historyAudit.call(session, 'queue_status', { include_snapshot: true });
            return result.snapshot.items.length;
          }, sessions[owner]!),
        { timeout: 90_000 }
      )
      .toBeGreaterThanOrEqual(752);
    // These must arrive live too, not only after snapshot hydration.
    await expect(
      page.locator('[data-deck-column]').nth(owner).getByRole('log').getByText(`HISTORY_${owner}_0749`, { exact: true })
    ).toHaveCount(1);
  }
  const hydrateStart = Date.now();
  await page.reload();
  await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  const columns = [0, 1].map((i) => page.locator('[data-deck-column]').nth(i));
  for (let i = 0; i < 2; i++) {
    await expect(columns[i]!.getByRole('log').getByText(`HISTORY_${i}_0749`, { exact: true })).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(columns[i]!.getByRole('log')).not.toContainText(`HISTORY_${1 - i}_`);
    await expect(columns[i]!.getByRole('log').getByText(new RegExp(`^HISTORY_${i}_\\d{4}$`))).toHaveCount(750);
    await expect(columns[i]!.getByRole('textbox')).toBeEditable();
  }
  const hydrateMs = Date.now() - hydrateStart;
  await columns[0]!.getByRole('textbox').fill('SOAK_LARGE_HISTORY WAIT_FOR_SESSION_A');
  await columns[0]!.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(columns[0]!.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const logA = columns[0]!.getByRole('log');
  await logA.hover();
  await page.mouse.wheel(0, -200000);
  await expect(logA.getByText('HISTORY_0_0000', { exact: true })).toBeInViewport();
  await columns[1]!.getByRole('textbox').fill('second tile draft during long-history stream');
  for (let i = 0; i < 3; i++) {
    await columns[1]!.getByRole('textbox').click();
    await page.getByRole('radio', { name: 'Focus', exact: true }).click();
    await expect(inputs).toHaveValue('second tile draft during long-history stream');
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
  }
  await expect(columns[0]!.getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(1, { timeout: 90_000 });
  // Selecting tile B may pan the horizontal deck and clip A's left-aligned
  // reply behind the sidebar. Reveal A's outer column without scrolling its
  // inner transcript (which must still be at the user's reading position).
  await columns[0]!.scrollIntoViewIfNeeded();
  await expect(logA.getByText('HISTORY_0_0000', { exact: true })).toBeInViewport();
  await columns[0]!.getByRole('button', { name: 'Jump to latest message', exact: true }).click();
  await expect(logA.getByText('SESSION_A_REPLY', { exact: true })).toBeInViewport();
  await expect(columns[1]!.getByRole('log')).not.toContainText('SESSION_A_REPLY');
  await expect(columns[1]!.getByRole('textbox')).toHaveValue('second tile draft during long-history stream');
  await info.attach('history hydration timing', {
    body: JSON.stringify({ items: 1500, hydrateMs }),
    contentType: 'application/json',
  });
  await attachProofPng(
    info,
    'large histories retain tile ownership through streaming and scroll',
    await page.screenshot()
  );
});
