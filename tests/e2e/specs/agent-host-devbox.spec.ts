import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofScreenshot } from 'tests/e2e/support/proof';

type RuntimeStatus = {
  type: string;
  data?: {
    agentHostId?: string;
    workspaceId?: string;
    environmentId?: string;
    containerId?: string;
  };
};

test.use({ seedState: 'pooled-devboxes' });

async function status(page: Page, processId: string): Promise<RuntimeStatus> {
  return page.evaluate(async (id) => {
    const current = await window.electron.ipcRenderer.invoke('agent-process:get-status', id);
    if (current?.type !== 'running') {
      return { type: current?.type ?? 'uninitialized' };
    }
    return {
      type: current.type,
      data: {
        agentHostId: current.data.agentHostId,
        workspaceId: current.data.workspaceId,
        environmentId: current.data.environmentId,
        containerId: current.data.containerId,
      },
    };
  }, processId);
}

async function openSession(
  page: Page,
  name: string,
  processId: string,
  distinctFrom?: RuntimeStatus
): Promise<RuntimeStatus> {
  const session = page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', { name });
  await expect(session).toBeVisible({ timeout: 120_000 });
  await session.click();
  await expect
    .poll(
      async () => {
        const current = await status(page, processId);
        return (
          current.type === 'running' &&
          Boolean(current.data?.workspaceId) &&
          Boolean(current.data?.environmentId) &&
          (!distinctFrom ||
            (current.data?.workspaceId !== distinctFrom.data?.workspaceId &&
              current.data?.environmentId !== distinctFrom.data?.environmentId))
        );
      },
      { timeout: 300_000 }
    )
    .toBe(true);
  return status(page, processId);
}

async function openIdentity(page: Page, mountName: string, expected: string) {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const surface = page.getByRole('region', { name: 'Workspace files', exact: true });
  await expect(surface).toBeVisible({ timeout: 120_000 });
  const tree = surface.getByRole('tree', { name: 'Workspace files' });
  const mount = tree.getByRole('treeitem', { name: mountName, exact: true });
  await expect(mount).toBeVisible({ timeout: 120_000 });
  await mount.click();
  const identity = tree.getByRole('treeitem', {
    name: 'identity.txt',
    exact: true,
  });
  await expect(identity).toBeVisible({ timeout: 120_000 });
  await identity.click();
  const editor = page.getByRole('textbox', { name: `Editor for ${mountName}/identity.txt` });
  await expect(editor).toHaveText(expected);
  return { editor, surface };
}

test.describe('AgentHost Devbox routing', () => {
  test('isolates Files, Git, and Terminal across two environments on one host', async ({ app }, testInfo) => {
    test.setTimeout(600_000);
    const page = app.page;

    const alpha = await openSession(page, 'Pool Alpha', 'code-e2e-pool-alpha');
    const beta = await openSession(page, 'Pool Beta', 'code-e2e-pool-beta', alpha);
    expect(alpha.data?.agentHostId).toBeTruthy();
    expect(alpha.data?.agentHostId).toBe(beta.data?.agentHostId);
    expect(alpha.data?.workspaceId).not.toBe(beta.data?.workspaceId);
    expect(alpha.data?.environmentId).not.toBe(beta.data?.environmentId);
    expect(alpha.data?.containerId).toBeTruthy();
    expect(alpha.data?.containerId).not.toBe(beta.data?.containerId);

    await openSession(page, 'Pool Alpha', 'code-e2e-pool-alpha');
    const alphaFiles = await openIdentity(page, 'pool-alpha', 'alpha workspace');
    await alphaFiles.editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('alpha changed in devbox\n');
    await page.keyboard.press('ControlOrMeta+S');
    await expect(
      alphaFiles.surface.getByRole('status').filter({ hasText: 'Saved pool-alpha/identity.txt' })
    ).toBeVisible();

    await page.getByRole('button', { name: 'Git', exact: true }).click();
    const sourceControl = page.getByRole('region', { name: 'Source control', exact: true });
    await expect(sourceControl).toBeVisible({ timeout: 120_000 });
    await expect(sourceControl.getByRole('button', { name: /identity\.txt/ }).first()).toBeVisible({
      timeout: 120_000,
    });

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminalInput = page.getByRole('textbox', { name: 'Terminal input' });
    await expect(terminalInput).toBeVisible({ timeout: 120_000 });
    await terminalInput.pressSequentially('pwd');
    await terminalInput.press('Enter');
    await expect(page.locator('.xterm-rows:visible')).toContainText('/workspace', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Close Terminal 1', exact: true }).click();

    await openSession(page, 'Pool Beta', 'code-e2e-pool-beta');
    await openIdentity(page, 'pool-beta', 'beta workspace');
    await attachProofScreenshot(page, testInfo, 'isolated Devbox Files Git and Terminal routing');
  });
});
