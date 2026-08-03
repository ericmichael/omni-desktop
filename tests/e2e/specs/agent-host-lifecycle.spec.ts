import path from 'node:path';

import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { invokeApp } from 'tests/e2e/support/invoke';
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

test.use({ seedState: 'pooled-workspaces' });

async function status(page: Page, processId: string): Promise<RuntimeStatus> {
  const current = await invokeApp<RuntimeStatus>(page, 'agent-process:get-status', processId);
  if (current?.type !== 'running') {
    return { type: current?.type ?? 'uninitialized' };
  }
  return {
    type: current.type,
    data: {
      agentHostId: current.data?.agentHostId,
      workspaceId: current.data?.workspaceId,
      environmentId: current.data?.environmentId,
      containerId: current.data?.containerId,
    },
  };
}

async function openSession(page: Page, name: string, processId: string): Promise<RuntimeStatus> {
  const session = page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', { name });
  await expect(session).toBeVisible({ timeout: 120_000 });
  await session.click();
  await expect.poll(async () => (await status(page, processId)).type, { timeout: 300_000 }).toBe('running');
  return status(page, processId);
}

async function expectRuntimeUnchanged(page: Page, processId: string, expected: RuntimeStatus): Promise<void> {
  await expect.poll(() => status(page, processId)).toEqual(expected);
}

test.describe('AgentHost consumer lifecycle', () => {
  test('switches, rebuilds, and closes one environment without disturbing its sibling', async ({ app }, testInfo) => {
    test.setTimeout(600_000);
    const page = app.page;
    const alphaId = 'code-e2e-pool-alpha';
    const betaId = 'code-e2e-pool-beta';

    const alphaHost = await openSession(page, 'Pool Alpha', alphaId);
    const beta = await openSession(page, 'Pool Beta', betaId);
    expect(alphaHost.data?.agentHostId).toBeTruthy();
    expect(alphaHost.data?.agentHostId).toBe(beta.data?.agentHostId);
    expect(alphaHost.data?.environmentId).not.toBe(beta.data?.environmentId);

    await openSession(page, 'Pool Alpha', alphaId);
    await page.getByRole('button', { name: 'Host', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Devbox (Docker)' }).click();

    await expect
      .poll(
        async () => {
          const current = await status(page, alphaId);
          return (
            current.type === 'running' &&
            current.data?.agentHostId === beta.data?.agentHostId &&
            Boolean(current.data?.containerId) &&
            current.data?.environmentId !== alphaHost.data?.environmentId
          );
        },
        { timeout: 300_000 }
      )
      .toBe(true);
    const alphaDevbox = await status(page, alphaId);
    expect(alphaDevbox.data?.environmentId).not.toBe(alphaHost.data?.environmentId);
    expect(alphaDevbox.data?.environmentId).not.toBe(beta.data?.environmentId);
    await expectRuntimeUnchanged(page, betaId, beta);

    await invokeApp(page, 'agent-process:rebuild', alphaId, { workspaceDir: path.join(app.workspaceDir, 'alpha') });
    await expect
      .poll(
        async () => {
          const current = await status(page, alphaId);
          return (
            current.type === 'running' &&
            current.data?.agentHostId === beta.data?.agentHostId &&
            Boolean(current.data?.containerId) &&
            current.data?.environmentId !== alphaDevbox.data?.environmentId &&
            current.data?.containerId !== alphaDevbox.data?.containerId
          );
        },
        { timeout: 300_000 }
      )
      .toBe(true);
    const alphaRebuilt = await status(page, alphaId);
    expect(alphaRebuilt.data?.environmentId).not.toBe(alphaDevbox.data?.environmentId);
    expect(alphaRebuilt.data?.containerId).not.toBe(alphaDevbox.data?.containerId);
    await expectRuntimeUnchanged(page, betaId, beta);

    await attachProofScreenshot(page, testInfo, 'rebuilt Devbox consumer beside unchanged host consumer');
    await page.getByRole('button', { name: 'Session menu' }).click();
    await page.getByRole('menuitem', { name: 'Close session', exact: true }).click();

    await expect.poll(async () => (await status(page, alphaId)).type).toBe('uninitialized');
    await expectRuntimeUnchanged(page, betaId, beta);
    await expect(
      page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', { name: 'Pool Alpha' })
    ).toHaveCount(0);
    await openSession(page, 'Pool Beta', betaId);
    await expect(page.getByRole('button', { name: 'Host', exact: true })).toBeVisible();
    await attachProofScreenshot(page, testInfo, 'closed Alpha while Beta and AgentHost remain live');
  });
});
