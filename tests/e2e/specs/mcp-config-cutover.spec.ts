import path from 'node:path';

import type { Locator, Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { openPlugins } from 'tests/e2e/support/app';
import { invokeApp } from 'tests/e2e/support/invoke';
import { attachProofPng } from 'tests/e2e/support/proof';
import {
  E2E_MCP_CREATED_SERVER_NAME,
  E2E_MCP_FIXTURE_FILE,
  E2E_MCP_SECRET,
  E2E_MCP_SERVER_NAME,
} from 'tests/e2e/support/state';

test.use({ seedState: 'mcp-migration' });

function connectorCard(page: Page, serverName: string): Locator {
  return page.locator('[data-slot="item"]').filter({ hasText: serverName });
}

async function openConnectors(page: Page): Promise<void> {
  await openPlugins(page);
  await page.getByRole('radio', { name: 'Connectors', exact: true }).click();
}

test.describe('MCP configuration ownership cutover', () => {
  test('migrates a safe connector without exposing or clobbering its secret', async ({ app, mode }, testInfo) => {
    test.skip(mode !== 'electron-local', 'Host-scoped MCP configuration belongs to the Electron-local runtime');
    test.setTimeout(300_000);

    await openConnectors(app.page);
    await invokeApp(app.page, 'settings:get-mcp-config');
    await expect.poll(() => app.inspectMcpConfig().ownedByOmniagents, { timeout: 120_000 }).toBe(true);

    const migrated = connectorCard(app.page, E2E_MCP_SERVER_NAME);
    const managed = connectorCard(app.page, 'omni-projects');
    await expect(migrated).toBeVisible({ timeout: 120_000 });
    await expect(managed).toContainText('Managed');
    await expect(managed).toContainText('Managed by the Omniagents host');
    await expect(managed.getByRole('button', { name: 'Configure' })).toHaveCount(0);
    await expect(app.page.getByRole('button', { name: 'Remove omni-projects' })).toHaveCount(0);
    await expect(app.page.getByText(E2E_MCP_SECRET, { exact: true })).toHaveCount(0);
    // Electron's BrowserWindow page shim does not expose Playwright's
    // getByDisplayValue helper; inspect the rendered input value directly.
    await expect(app.page.locator(`input[value="${E2E_MCP_SECRET}"]`)).toHaveCount(0);
    await attachProofPng(testInfo, 'canonical MCP migration and managed protection', await app.captureScreenshot());

    await migrated.getByRole('button', { name: 'Configure' }).click();
    const dialog = app.page.getByRole('dialog', { name: `Configure "${E2E_MCP_SERVER_NAME}"` });
    await expect(dialog).toBeVisible();
    const storedSecret = dialog.getByRole('textbox', { name: 'Environment variables E2E_MCP_TOKEN' });
    await expect(storedSecret).toHaveValue('');
    await expect(storedSecret).toHaveAttribute('placeholder', 'Stored value — leave blank to keep');
    await expect(dialog.locator(`input[value="${E2E_MCP_SECRET}"]`)).toHaveCount(0);
    const fixturePath = path.join(app.workspaceDir, E2E_MCP_FIXTURE_FILE);
    await dialog.locator('input[placeholder="arg1, arg2"]').fill(`${fixturePath}, --updated`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => app.inspectMcpConfig())
      .toMatchObject({
        ownedByOmniagents: true,
        migratedServerPresent: true,
        migratedServerUpdated: true,
        migratedSecretPreserved: true,
        managedServerPresent: true,
        mode: 0o600,
      });

    const restarted = await app.restart();
    await openConnectors(restarted);
    await expect(connectorCard(restarted, E2E_MCP_SERVER_NAME)).toContainText('--updated', { timeout: 120_000 });
    await expect(restarted.getByText(E2E_MCP_SECRET, { exact: true })).toHaveCount(0);
    expect(app.inspectMcpConfig()).toMatchObject({
      ownedByOmniagents: true,
      migratedServerPresent: true,
      migratedServerUpdated: true,
      migratedSecretPreserved: true,
      managedServerPresent: true,
    });
    await attachProofPng(testInfo, 'migrated MCP update survives restart', await app.captureScreenshot());
  });

  test('keeps canonical create and update durable and never resurrects a deleted connector', async ({
    app,
    mode,
  }, testInfo) => {
    test.skip(mode !== 'electron-local', 'Host-scoped MCP configuration belongs to the Electron-local runtime');
    test.setTimeout(420_000);

    await openConnectors(app.page);
    await invokeApp(app.page, 'settings:get-mcp-config');
    await expect.poll(() => app.inspectMcpConfig().ownedByOmniagents, { timeout: 120_000 }).toBe(true);
    const fixturePath = path.join(app.workspaceDir, E2E_MCP_FIXTURE_FILE);

    await app.page.getByRole('button', { name: 'Add MCP server', exact: true }).click();
    const createDialog = app.page.getByRole('dialog', { name: 'Add MCP server' });
    await createDialog.locator('input[placeholder="my-server"]').fill(E2E_MCP_CREATED_SERVER_NAME);
    await createDialog.locator('input[placeholder="npx"]').fill(process.execPath);
    await createDialog.locator('input[placeholder="arg1, arg2"]').fill(fixturePath);
    await createDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(createDialog).toBeHidden();
    const created = connectorCard(app.page, E2E_MCP_CREATED_SERVER_NAME);
    await expect(created).toBeVisible();
    await expect.poll(() => app.inspectMcpConfig().createdServerPresent).toBe(true);

    await created.getByRole('button', { name: 'Configure' }).click();
    const editDialog = app.page.getByRole('dialog', { name: `Configure "${E2E_MCP_CREATED_SERVER_NAME}"` });
    await editDialog.locator('input[placeholder="arg1, arg2"]').fill(`${fixturePath}, --created-v2`);
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editDialog).toBeHidden();
    await expect.poll(() => app.inspectMcpConfig().createdServerUpdated).toBe(true);
    await attachProofPng(testInfo, 'canonical MCP create and update', await app.captureScreenshot());

    const restarted = await app.restart();
    await openConnectors(restarted);
    const durable = connectorCard(restarted, E2E_MCP_CREATED_SERVER_NAME);
    await expect(durable).toContainText('--created-v2', { timeout: 120_000 });
    expect(app.inspectMcpConfig()).toMatchObject({ createdServerPresent: true, createdServerUpdated: true });

    await durable.getByRole('button', { name: `Remove ${E2E_MCP_CREATED_SERVER_NAME}` }).click();
    const confirmation = restarted.getByRole('alertdialog', {
      name: `Remove "${E2E_MCP_CREATED_SERVER_NAME}"?`,
    });
    await confirmation.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(durable).toHaveCount(0);
    await expect.poll(() => app.inspectMcpConfig().createdServerPresent).toBe(false);

    const afterDeleteRestart = await app.restart();
    await openConnectors(afterDeleteRestart);
    await expect(connectorCard(afterDeleteRestart, E2E_MCP_CREATED_SERVER_NAME)).toHaveCount(0);
    expect(app.inspectMcpConfig()).toMatchObject({
      ownedByOmniagents: true,
      createdServerPresent: false,
      migratedServerPresent: true,
      managedServerPresent: true,
    });
    await attachProofPng(testInfo, 'deleted MCP connector does not resurrect', await app.captureScreenshot());
  });
});
