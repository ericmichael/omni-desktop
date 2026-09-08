import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

test('rejects a legacy peer and sends the pending message once after a compatible retry', async ({ app }, info) => {
  test.setTimeout(240_000);
  const page = app.page;
  let legacy = true;
  const blockedMethods: string[] = [];
  const submissions: string[] = [];
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    let blocked = false;
    socket.onMessage((data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === 'initialize' && legacy && frame.params?.identity?.name === 'omni-desktop') {
        blocked = true;
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: {
              code: -32012,
              message: 'Unsupported protocol version',
              data: { kind: 'protocol_version_mismatch', client_version: '2.0.0', server_version: '1.0.0' },
            },
          })
        );
        return;
      }
      if (blocked) {
        if (frame?.method) {
          blockedMethods.push(frame.method);
        }
        return;
      }
      if (frame?.method === 'start_run' || frame?.method === 'enqueue_message') {
        submissions.push(String(data));
      }
      server.send(data);
    });
    server.onMessage((data) => {
      if (!blocked) {
        socket.send(data);
      }
    });
    socket.onClose((code, reason) => {
      void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      void socket.close({ code, reason });
    });
  });
  await page.reload();
  const input = page.getByRole('textbox', { name: 'How can I help you today?' });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Workstation', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
  const prompt = 'PROTOCOL_VERSION_PENDING_MESSAGE';
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page.getByText(/Desktop requires v2\.0\.0; server reports 1\.0\.0/)).toBeVisible({ timeout: 90_000 });
  expect(blockedMethods).toEqual([]);
  expect(submissions).toEqual([]);
  await attachProofPng(info, 'incompatible peer rejected before submission', await app.captureScreenshot());
  legacy = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('log').getByText(prompt, { exact: true })).toHaveCount(1);
  expect(submissions.filter((data) => data.includes(prompt))).toHaveLength(1);
  expect(blockedMethods).toEqual([]);
  await attachProofPng(info, 'compatible retry preserved pending message', await app.captureScreenshot());
});
