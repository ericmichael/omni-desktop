import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

const input = (page: Page) => page.getByRole('textbox', { name: 'How can I help you today?' });
const setting = (page: Page, title: string) => page.getByRole('button').and(page.getByTitle(title, { exact: true }));

async function holdRpcReply(page: Page, method: string) {
  await page.evaluate((method) => {
    delete (window as any).releaseSettingsReply;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {}
      if (frame?.method === method) {
        (window as any).auditSettingsSocket = this;
        WebSocket.prototype.send = send;
        const receive = this.onmessage;
        this.onmessage = (event) => {
          let reply;
          try {
            reply = JSON.parse(String(event.data));
          } catch {}
          if (reply?.id === frame.id) {
            (window as any).releaseSettingsReply = () => {
              this.onmessage = receive;
              receive?.call(this, event);
            };
            return;
          }
          receive?.call(this, event);
        };
      }
      return send.call(this, data);
    };
  }, method);
}

test('a competing approval reply and remote archive converge in both windows', async ({ app, mode }, info) => {
  test.skip(mode !== 'server-local', 'Independent browser windows share the same launcher authority');
  test.setTimeout(180_000);
  const a = app.page;
  await expect(input(a)).toBeVisible({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('TILE_APPROVAL_C_SHARED');
  await input(a).press('Enter');
  await expect(a.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'TILE_APPROVAL_C_SHARED', exact: true })
      .click();
    await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    await b.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let frame;
        try {
          frame = JSON.parse(String(data));
        } catch {}
        if (frame?.method === 'tool_approval_response') {
          WebSocket.prototype.send = send;
          (window as any).releaseApproval = () => send.call(this, data);
          return;
        }
        return send.call(this, data);
      };
    });
    await b.getByRole('button', { name: 'Approve Once', exact: true }).click();
    await expect.poll(() => b.evaluate(() => typeof (window as any).releaseApproval)).toBe('function');
    await a.getByRole('button', { name: 'Approve Once', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
    await b.evaluate(() => (window as any).releaseApproval());
    for (const page of [a, b]) {
      await expect(page.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    }
    await input(b).fill('SHARED_AFTER_APPROVAL');
    await input(b).press('Enter');
    for (const page of [a, b]) {
      await expect(page.getByRole('log').getByText('SHARED_AFTER_APPROVAL', { exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
    }
    await attachProofPng(info, 'competing approval resolved in second window', await b.screenshot());
    await a.getByRole('button', { name: 'Session menu', exact: true }).click();
    await a.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
    await expect(b.getByRole('log').filter({ hasText: 'TILE_APPROVAL_C_SHARED' })).toHaveCount(0);
    await expect.poll(() => app.inspectChatCleanup().jobs.length).toBe(0);
    await attachProofPng(info, 'remote archive retires second window', await b.screenshot());
  } finally {
    await b.close();
  }
});

test('two windows converge on model and reviewer settings for the same live session', async ({ app, mode }, info) => {
  test.skip(mode !== 'server-local', 'Independent browser windows share the same launcher authority');
  test.setTimeout(180_000);
  const a = app.page;
  await expect(input(a)).toBeVisible({ timeout: 90_000 });
  await a.getByRole('button', { name: 'Workstation', exact: true }).click();
  await a.getByRole('menuitemradio', { name: /^My computer/ }).click();
  await input(a).fill('SHARED_SESSION_SETTINGS');
  await input(a).press('Enter');
  await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
  const b = await a.context().newPage();
  try {
    await b.goto(a.url());
    await b
      .getByRole('list', { name: 'Recents' })
      .getByRole('button', { name: 'SHARED_SESSION_SETTINGS', exact: true })
      .click();
    await expect(b.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(b.getByRole('button', { name: 'GPT 5.2 E2E', exact: true })).toBeEnabled();
    await a.getByRole('button', { name: 'GPT 5.2 E2E', exact: true }).click();
    await a.getByRole('menuitemradio', { name: /GPT 5.2 Mini E2E/ }).click();
    await expect(a.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Ask me', exact: true }).click();
    await a.getByRole('menuitemradio', { name: 'Approve for me', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Approve for me', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Approve for me', exact: true }).click();
    await a.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
    await b.getByRole('button', { name: 'Approve for me', exact: true }).click();
    await expect(b.getByRole('menuitemradio', { name: 'Off', exact: true })).toBeChecked();
    await b.keyboard.press('Escape');
    // A's accepted mutation reply is delayed while B makes a newer change.
    // The old reply must not overwrite notifications of B's newer choice.
    await holdRpcReply(a, 'set_session_model');
    await a.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true }).click();
    await a.getByRole('menuitemradio', { name: /^GPT 5\.2 E2E/ }).click();
    await expect.poll(() => a.evaluate(() => typeof (window as any).releaseSettingsReply)).toBe('function');
    await b.getByRole('button', { name: 'GPT 5.2 E2E', exact: true }).click();
    await b.getByRole('menuitemradio', { name: /GPT 5.2 Mini E2E/ }).click();
    await expect(a.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true })).toBeVisible();
    await a.evaluate(() => (window as any).releaseSettingsReply());
    await expect(a.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true })).toBeEnabled();

    for (const scenario of [
      {
        method: 'set_session_reasoning',
        title: 'Choose reasoning effort for this conversation',
        first: 'High',
        second: 'Low',
      },
      {
        method: 'set_session_approvals',
        title: 'Approvals and task checks for this conversation',
        first: 'Ask me first',
        second: 'Approve for me',
      },
      {
        method: 'set_session_workflow',
        title: 'Approvals and task checks for this conversation',
        first: 'On',
        second: 'Off',
      },
    ]) {
      await holdRpcReply(a, scenario.method);
      await setting(a, scenario.title).click();
      await a.getByRole('menuitemradio', { name: new RegExp(`^${scenario.first}$`, 'i') }).click();
      await expect.poll(() => a.evaluate(() => typeof (window as any).releaseSettingsReply)).toBe('function');
      await setting(b, scenario.title).click();
      await expect(b.getByRole('menuitemradio', { name: new RegExp(`^${scenario.first}$`, 'i') })).toBeChecked();
      await b.getByRole('menuitemradio', { name: new RegExp(`^${scenario.second}$`, 'i') }).click();
      // The backend completes B's mutation before releasing A's older reply.
      await expect(setting(b, scenario.title)).toBeEnabled();
      await a.evaluate(() => (window as any).releaseSettingsReply());
      await setting(a, scenario.title).click();
      await expect(a.getByRole('menuitemradio', { name: new RegExp(`^${scenario.second}$`, 'i') })).toBeChecked();
      await a.keyboard.press('Escape');
    }
    await attachProofPng(info, 'second window receives session settings', await b.screenshot());
    await attachProofPng(info, 'first window retains newer settings after delayed replies', await a.screenshot());
    const network = await a.context().newCDPSession(a);
    await network.send('Network.enable');
    try {
      await network.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await a.evaluate(() => (window as any).auditSettingsSocket.close(4001, 'offline settings audit'));
      await expect(input(a)).toBeDisabled();
      await b.getByRole('button', { name: 'GPT 5.2 Mini E2E', exact: true }).click();
      await b.getByRole('menuitemradio', { name: /^GPT 5\.2 E2E/ }).click();
      await setting(b, 'Choose reasoning effort for this conversation').click();
      await b.getByRole('menuitemradio', { name: /^High$/i }).click();
      await b.getByRole('button', { name: 'Approve for me', exact: true }).click();
      await b.getByRole('menuitemradio', { name: 'Ask me first', exact: true }).click();
      await b.getByRole('button', { name: 'Ask me', exact: true }).click();
      await b.getByRole('menuitemradio', { name: 'On', exact: true }).click();
      await input(b).fill('CHANGED_WHILE_OTHER_WINDOW_OFFLINE');
      await input(b).press('Enter');
      await expect(b.getByRole('log')).toContainText('CHANGED_WHILE_OTHER_WINDOW_OFFLINE');
    } finally {
      await network.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await network.detach();
    }
    await expect(input(a)).toBeEditable({ timeout: 90_000 });
    await expect(a.getByRole('button', { name: 'GPT 5.2 E2E', exact: true })).toBeEnabled();
    await expect(a.getByRole('log').getByText('CHANGED_WHILE_OTHER_WINDOW_OFFLINE', { exact: true })).toHaveCount(1);
    await setting(a, 'Choose reasoning effort for this conversation').click();
    await expect(a.getByRole('menuitemradio', { name: /^High$/i })).toBeChecked();
    await a.keyboard.press('Escape');
    await a.getByRole('button', { name: 'Ask me', exact: true }).click();
    await expect(a.getByRole('menuitemradio', { name: 'On', exact: true })).toBeChecked();
    await a.keyboard.press('Escape');
    await attachProofPng(
      info,
      'missed settings and transcript recovered after offline window returns',
      await a.screenshot()
    );
  } finally {
    await b.close();
  }
});
