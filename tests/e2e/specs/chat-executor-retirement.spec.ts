import { readFileSync } from 'node:fs';

import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'lazy-host-first-message' });

function descendants(roots: number[]): number[] {
  const found = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (found.has(pid)) {
      continue;
    }
    found.add(pid);
    try {
      pending.push(
        ...readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
      );
    } catch {
      /* A process may exit during the snapshot. */
    }
  }
  return [...found];
}

function isRunning(pid: number): boolean {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z ');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
}

for (const crash of [false, true]) {
  test(`${crash ? 'Backend death' : 'Stop'} retires the owned command tree with another tile open`, async ({
    app,
    mode,
  }, info) => {
    test.skip(process.platform !== 'linux', 'Uses /proc to verify actual command retirement');
    test.skip(crash && mode !== 'server-local', 'Crash/restart uses the isolated server fixture');
    test.setTimeout(240_000);
    const page = app.page;
    const inputs = page.getByRole('textbox', { name: 'How can I help you today?' });
    await expect(inputs).toBeVisible({ timeout: 90_000 });
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const aId = await page.locator('[data-deck-column]').first().getAttribute('data-deck-column');
    const a = page.locator(`[data-deck-column="${aId}"]`);
    await a.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await a.getByRole('textbox').fill('STOP_EXECUTOR_TREE');
    await a.getByRole('textbox').press('Enter');
    await a.getByRole('button', { name: 'Approve Once', exact: true }).click({ timeout: 90_000 });
    let ownedPids: number[] = [];
    await expect
      .poll(
        () => {
          ownedPids = descendants(app.inspectChatCleanup().runtimePids).filter((pid) => {
            try {
              const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
              return ['OMNI_EXECUTOR_PARENT', 'OMNI_EXECUTOR_CHILD'].includes(args.at(-1) ?? '');
            } catch {
              return false;
            }
          });
          return ownedPids.length;
        },
        { timeout: 30_000 }
      )
      .toBe(2);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('radio', { name: 'Spaces', exact: true }).click();
    const b = page.locator(`[data-deck-column]:not([data-deck-column="${aId}"])`);
    await expect(b).toHaveCount(1);
    await b.getByRole('button', { name: 'Workstation', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^My computer/ }).click();
    await b.getByRole('textbox').fill('TILE_APPROVAL_B');
    await b.getByRole('textbox').press('Enter');
    await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible({ timeout: 90_000 });
    if (crash) {
      await a.getByRole('textbox').fill('QUEUED_AFTER_EXECUTOR_CRASH');
      await a.getByRole('textbox').press('Enter');
      await expect(a.getByText('Up next', { exact: true })).toBeVisible();
      const scoped = descendants(app.inspectChatCleanup().runtimePids);
      const supervisor = scoped
        .map((pid) => {
          const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
          const script = args.findIndex((arg) => arg.endsWith('/workspace/_supervisor.py'));
          return script < 0 ? null : { pid, journal: args[script + 3]! };
        })
        .find((entry) => entry && ownedPids.every((pid) => descendants([entry.pid]).includes(pid)));
      expect(supervisor).toBeTruthy();
      const backendPid = Number(readFileSync(`/proc/${supervisor!.pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]);
      expect(scoped).toContain(backendPid);
      // Kill only the real agent backend. Do not let fixture teardown kill the
      // command tree and accidentally masquerade as supervisor crash recovery.
      process.kill(backendPid, 'SIGKILL');
      await expect.poll(() => ownedPids.every((pid) => !isRunning(pid)), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => JSON.parse(readFileSync(supervisor!.journal, 'utf8')).state).toBe('interrupted');
      expect(JSON.parse(readFileSync(supervisor!.journal, 'utf8')).descendants_reaped).toBe(true);
      const restoredPage = await app.restart({ crash: true });
      const restoredA = restoredPage.locator(`[data-deck-column="${aId}"]`);
      const restoredB = restoredPage.locator(`[data-deck-column]:not([data-deck-column="${aId}"])`);
      await expect(restoredA.getByText(/Waiting for the previous runtime/)).toBeVisible({ timeout: 90_000 });
      await expect(restoredA.getByRole('log').getByText('QUEUED_AFTER_EXECUTOR_CRASH', { exact: true })).toHaveCount(0);
      await expect(restoredB.getByRole('log')).toContainText('TILE_APPROVAL_B');
      await expect(restoredB.getByRole('log')).not.toContainText('STOP_EXECUTOR_TREE');
      await expect(restoredB.getByRole('button', { name: 'Approve Once', exact: true })).toHaveCount(0);
      await restoredA.evaluate((element) => element.scrollIntoView({ block: 'nearest', inline: 'start' }));
      await attachProofPng(
        info,
        'backend crash retires commands without replay or cross-tile content',
        await app.captureScreenshot()
      );
      return;
    }
    await a.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => ownedPids.every((pid) => !isRunning(pid)), { timeout: 10_000 }).toBe(true);
    await expect(b.getByRole('button', { name: 'Approve Once', exact: true })).toBeVisible();
    await a.getByRole('textbox').fill('AFTER_EXECUTOR_STOP');
    await a.getByRole('textbox').press('Enter');
    await expect(a.getByText('HOST_FIRST_MESSAGE_READY', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(b.getByRole('log')).not.toContainText('AFTER_EXECUTOR_STOP');
    await attachProofPng(
      info,
      'command tree stopped and owner restarted while other tile waits',
      await app.captureScreenshot()
    );
    await b.getByRole('button', { name: 'Reject', exact: true }).click();
  });
}
