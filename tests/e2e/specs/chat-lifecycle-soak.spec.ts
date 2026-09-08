import { readFileSync } from 'node:fs';

import type { Locator, Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({
  seedState: 'lazy-host-first-message',
  extraHostProfile: true,
  // Keep actions/network diagnostics, explicit owner screenshots and the
  // full proof video. Per-action DOM snapshots over thirty minutes produce
  // multi-gigabyte traces; the focused story specs retain those snapshots.
  trace: { mode: 'on', snapshots: false, screenshots: false, sources: true },
});

const duration = Number(process.env.OMNI_CHAT_SOAK_MS ?? 0);
const textbox = (owner: Page | Locator) => owner.getByRole('textbox', { name: 'How can I help you today?' });
const dead = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z ') === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
};

test('sustains mixed conversation lifecycles and checks ownership and retirement', async ({ app, mode }, testInfo) => {
  test.skip(!duration, 'Opt in with OMNI_CHAT_SOAK_MS (1800000 for thirty minutes)');
  test.skip(mode !== 'server-local', 'Backend-only crash and /proc resource assertions require Linux server mode');
  test.setTimeout(duration + 360_000);
  const started = Date.now();
  const samples: object[] = [];
  let cycle = 0;
  let idleSocketBaseline: number | undefined;
  let page = app.page;
  const instrument = () => {
    const sockets = new Set<WebSocket>();
    const operations = new WeakMap<WebSocket, { first: string; last: string }>();
    const send = WebSocket.prototype.send;
    (window as any).soakDisconnect = () => sockets.forEach((socket) => socket.close(4001, 'soak reconnect'));
    (window as any).soakSocketCount = () =>
      [...sockets].filter((socket) => socket.readyState < WebSocket.CLOSING).length;
    (window as any).soakSocketPaths = () =>
      [...sockets]
        .filter((socket) => socket.readyState < WebSocket.CLOSING)
        .map((socket) => new URL(socket.url).pathname.replace(/\/proxy\/[^/]+/, '/proxy/:runtime'));
    (window as any).soakSocketDetails = () =>
      [...sockets]
        .filter((socket) => socket.readyState < WebSocket.CLOSING)
        .map((socket) => ({
          path: new URL(socket.url).pathname.replace(/\/proxy\/[^/]+/, '/proxy/:runtime'),
          state: socket.readyState,
          ...operations.get(socket),
        }));
    WebSocket.prototype.send = function (data) {
      try {
        const frame = JSON.parse(String(data));
        const operation = String(frame.method ?? frame.channel ?? 'response');
        operations.set(this, { first: operations.get(this)?.first ?? operation, last: operation });
      } catch {
        /* Only record method names, never credentials or payloads. */
      }
      if (!sockets.has(this)) {
        sockets.add(this);
        this.addEventListener('close', () => sockets.delete(this), { once: true });
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
            setTimeout(() => receive?.call(this, event), 15);
          }
        };
      }
      send.call(this, data);
    };
  };
  await page.addInitScript(instrument);
  await page.reload();

  const archive = async (column: Locator) => {
    await column.getByRole('button', { name: 'Session menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
    await expect(column).toHaveCount(0, { timeout: 90_000 });
  };

  try {
    do {
      cycle++;
      const prefix = `SOAK_${String(cycle).padStart(4, '0')}`;
      console.log('CHAT_SOAK_PHASE', cycle, 'create mixed tiles');
      const prompts = [
        `${prefix}_A TILE_UI_A WAIT_FOR_SESSION_A`,
        `${prefix}_B TILE_QUESTION_B`,
        `${prefix}_C TILE_APPROVAL_C`,
      ];
      const ids: string[] = [];
      await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
      for (let owner = 0; owner < 3; owner++) {
        if (owner > 0 || (await textbox(page).count()) !== 1 || (await textbox(page).inputValue())) {
          await page
            .getByRole('list', { name: 'Surfaces' })
            .getByRole('button', { name: 'New chat', exact: true })
            .click();
        }
        const column = page.locator('[data-deck-column]').last();
        await expect(textbox(column)).toBeEditable({ timeout: 90_000 });
        const picker = column.getByRole('button', { name: 'Workstation', exact: true });
        if (await picker.isVisible()) {
          await picker.click();
          await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
        }
        ids.push((await column.getAttribute('data-deck-column'))!);
        await textbox(column).fill(prompts[owner]!);
        await textbox(column).press('Enter');
      }
      const [a, b, c] = ids.map((id) => page.locator(`[data-deck-column="${id}"]`)) as [Locator, Locator, Locator];
      await expect(a.getByText('A_ARTIFACT_initial', { exact: true })).toBeVisible({ timeout: 120_000 });
      await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(c.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
      await textbox(b).fill(`${prefix}_B_DRAFT`);
      await b
        .locator('input[type="file"]')
        .setInputFiles({ name: `${prefix}_B.txt`, mimeType: 'text/plain', buffer: Buffer.from(prefix) });
      await page.evaluate(() => (window as any).soakDisconnect());
      await expect(textbox(a)).toBeEditable({ timeout: 90_000 });
      await expect(a.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
      await a.getByRole('button', { name: /GPT 5\.2 E2E/ }).click();
      await page.getByRole('menuitemradio', { name: /GPT 5\.2 Mini E2E/ }).click();
      await expect(a.getByRole('button', { name: /GPT 5\.2 Mini E2E/ })).toBeVisible();
      await expect(b.getByRole('button', { name: /GPT 5\.2 E2E/ })).toBeVisible();
      const accepted = `${prefix}_ACCEPTED`;
      await textbox(a).fill(accepted);
      await textbox(a).press('Enter');
      await expect(a.getByRole('log').getByText(accepted, { exact: true })).toHaveCount(1);
      await expect(a.getByRole('log').getByText('SESSION_A_REPLY', { exact: true })).toHaveCount(2, {
        timeout: 90_000,
      });
      expect(app.inspectModelRequests().filter((request) => request.marker === accepted)).toEqual([
        { marker: accepted, model: 'gpt-5.2-mini' },
      ]);
      await a.getByRole('button', { name: /^Reorder / }).focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      if (cycle % Number(process.env.OMNI_CHAT_SOAK_RELOAD_EVERY ?? 7) === 0) {
        await page.reload();
      }
      await expect(textbox(b)).toHaveValue(`${prefix}_B_DRAFT`, { timeout: 90_000 });
      await expect(b.getByText(`${prefix}_B.txt`, { exact: true }).first()).toBeVisible();
      await expect(a.getByRole('log').getByText(accepted, { exact: true })).toHaveCount(1);
      await expect(a.getByText('A_ARTIFACT_initial', { exact: true })).toHaveCount(1);
      await expect(a.getByText('A_PLAN_initial', { exact: true }).first()).toBeVisible();
      for (let owner = 0; owner < 3; owner++) {
        const column = [a, b, c][owner]!;
        for (let other = 0; other < 3; other++) {
          if (other !== owner) {
            await expect(column.getByRole('log')).not.toContainText(prompts[other]!);
          }
        }
      }
      const original = app.inspectChatCleanup().tabs.find((tab) => tab.id === ids[2])!;
      console.log('CHAT_SOAK_PHASE', cycle, 'archive and restore approval owner');
      await archive(c);
      await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
      // Only this cycle's C is newly archived; select its row by visible title.
      const dialog = page.getByRole('dialog');
      const row = dialog
        .locator('div')
        .filter({ has: page.getByText(prompts[2]!, { exact: true }) })
        .filter({ has: page.getByRole('button', { name: 'Restore', exact: true }) })
        .last();
      await row.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('list', { name: 'Recents' }).getByRole('button', { name: prompts[2]!, exact: true }).click();
      await expect
        .poll(() => app.inspectChatCleanup().tabs.find((tab) => tab.sessionId === original.sessionId)?.id)
        .not.toBeUndefined();
      const restored = app.inspectChatCleanup().tabs.find((tab) => tab.sessionId === original.sessionId)!;
      expect(restored.snapshotRef).not.toBe(original.snapshotRef);
      const restoredC = page.locator(`[data-deck-column="${restored.id}"]`);
      await expect(restoredC.getByRole('log')).toContainText(prompts[2]!);
      await expect(restoredC.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
      await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible();
      await textbox(restoredC).fill(`${prefix}_RESTORED`);
      await textbox(restoredC).press('Enter');
      await expect(restoredC.getByRole('log')).toContainText('HOST_FIRST_MESSAGE_READY', { timeout: 90_000 });
      console.log('CHAT_SOAK_PHASE', cycle, 'switch live environment');
      await expect(restoredC.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await restoredC.getByRole('button', { name: 'My computer', exact: true }).click();
      await page.getByRole('menuitemradio', { name: /^soak-host/i }).click();
      await expect(restoredC.getByRole('button', { name: /^soak-host$/i })).toBeVisible();
      await expect(textbox(restoredC)).toBeEditable({ timeout: 90_000 });
      await textbox(restoredC).fill(`${prefix}_SWITCHED`);
      await textbox(restoredC).press('Enter');
      await expect(restoredC.getByRole('log').getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(2, {
        timeout: 90_000,
      });
      await expect(restoredC.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
      await expect(b.getByText('Question for tile B', { exact: true })).toBeVisible();
      expect(app.inspectModelRequests().filter((request) => request.marker === `${prefix}_SWITCHED`)).toEqual([
        { marker: `${prefix}_SWITCHED`, model: 'gpt-5.2' },
      ]);
      const { workerPids, ...resources } = await app.inspectChatResources();
      expect(resources.activeEnvironments).toBeLessThanOrEqual(3);
      if (cycle === 1 || cycle % 5 === 0) {
        for (const [owner, column] of [a, b, restoredC].entries()) {
          await attachProofPng(testInfo, `${prefix} owner ${owner} isolated conversation`, await column.screenshot());
        }
      }
      const hosts = [...app.inspectChatCleanup().runtimePids, ...workerPids];
      const cId = restored.id;
      if (cycle % Number(process.env.OMNI_CHAT_SOAK_RESTART_EVERY ?? 10) === 0) {
        console.log('CHAT_SOAK_PHASE', cycle, 'backend-only crash');
        const previousPage = page;
        page = await app.restart({ crash: true, backendOnly: true });
        expect(page).toBe(previousPage);
        await expect.poll(() => hosts.every(dead), { timeout: 90_000 }).toBe(true);
        await expect(textbox(page.locator(`[data-deck-column="${ids[1]}"]`))).toHaveValue(`${prefix}_B_DRAFT`, {
          timeout: 90_000,
        });
        await expect(
          page.locator(`[data-deck-column="${ids[1]}"]`).getByText(`${prefix}_B.txt`, { exact: true }).first()
        ).toBeVisible();
        const resumedC = page.locator(`[data-deck-column="${cId}"]`);
        await expect(textbox(resumedC)).toBeEditable({ timeout: 90_000 });
        await textbox(resumedC).fill(`${prefix}_AFTER_CRASH`);
        await textbox(resumedC).press('Enter');
        await expect(resumedC.getByRole('log').getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toHaveCount(3, {
          timeout: 90_000,
        });
        await app.inspectChatResources();
      }
      console.log('CHAT_SOAK_PHASE', cycle, 'retire all owners');
      for (const id of [ids[0]!, ids[1]!, cId]) {
        await archive(page.locator(`[data-deck-column="${id}"]`));
      }
      // Backend restart/reload can introduce an extra empty draft column.
      // Retire those through the same user action so the harness itself does
      // not accumulate deliberately open, unused chats between cycles.
      const extras = app.inspectChatCleanup().tabs.slice(1);
      for (const tab of extras) {
        await archive(page.locator(`[data-deck-column="${tab.id}"]`));
      }
      await expect.poll(() => app.inspectChatCleanup().jobs, { timeout: 90_000 }).toEqual([]);
      console.log('CHAT_SOAK_PHASE', cycle, 'verify environment retirement');
      // The targetless product-management consumer intentionally shares a
      // host with chat tiles. Its process can remain alive, but no retired
      // chat environment may remain ready/stopping. Probe previously observed
      // hosts even after their chat journals have been removed.
      await expect.poll(async () => (await app.inspectChatResources()).activeEnvironments, { timeout: 90_000 }).toBe(0);
      // The targetless management host does not need per-session MCP workers.
      // Environment descriptors alone missed workers leaked by retired chats.
      await expect.poll(async () => (await app.inspectChatResources()).childProcesses, { timeout: 30_000 }).toBe(0);
      const idle = await app.inspectChatResources();
      expect(idle.hosts).toBeLessThanOrEqual(2);
      expect(app.inspectChatCleanup().runtimePids).toEqual([]);
      if (idleSocketBaseline !== undefined) {
        await expect
          .poll(() => page.evaluate(() => (window as any).soakSocketCount()), { timeout: 30_000 })
          .toBeLessThanOrEqual(idleSocketBaseline + 2);
      }
      const browserState = await page.evaluate(() => ({
        nodes: document.querySelectorAll('*').length,
        sockets: (window as any).soakSocketCount?.(),
        heapBytes: (performance as any).memory?.usedJSHeapSize,
        socketPaths: (window as any).soakSocketPaths?.(),
      }));
      idleSocketBaseline ??= browserState.sockets;
      const sample = {
        cycle,
        elapsedMs: Date.now() - started,
        ...resources,
        ...browserState,
        cleanupJobs: 0,
        liveSharedHosts: idle.hosts,
        activeEnvironmentsAfterCleanup: idle.activeEnvironments,
        idleRssBytes: idle.rssBytes,
        idleFileDescriptors: idle.fileDescriptors,
        idleChildProcesses: idle.childProcesses,
      };
      samples.push(sample);
      console.log('CHAT_SOAK_CYCLE', JSON.stringify(sample));
      if (cycle === 1 || cycle % 5 === 0) {
        await attachProofPng(testInfo, `cycle ${cycle} retired resources`, await app.captureScreenshot());
      }
    } while (Date.now() - started < duration || cycle < Number(process.env.OMNI_CHAT_SOAK_MIN_CYCLES ?? 1));
  } finally {
    const sockets = await page.evaluate(() => (window as any).soakSocketDetails?.()).catch(() => null);
    await testInfo.attach('lifecycle soak samples', {
      body: JSON.stringify(
        { requestedMs: duration, elapsedMs: Date.now() - started, cycles: cycle, samples, sockets },
        null,
        2
      ),
      contentType: 'application/json',
    });
  }
});
