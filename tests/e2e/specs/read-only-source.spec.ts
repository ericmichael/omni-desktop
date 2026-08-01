import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';

async function createProject(page: Page, projectName: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill(projectName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(projectName, { exact: true }).last()).toBeVisible();
}

async function openProject(page: Page, projectName: string): Promise<void> {
  await page.getByRole('tree', { name: 'Projects' }).getByRole('treeitem', { name: projectName }).click();
  await expect(page.getByText(projectName, { exact: true }).last()).toBeVisible();
}

async function openSourceEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Source actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit source' }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Edit source' })).toBeVisible();
}

test.describe('read-only project sources', () => {
  test('keeps a source read-only after editing and restart', async ({ app }) => {
    const projectName = 'E2E Read-only Source';

    await createProject(app.page, projectName);
    await app.page.getByRole('button', { name: 'Add source' }).click();
    await expect(app.page.getByRole('dialog').filter({ hasText: 'Add source' })).toBeVisible();
    await app.page.getByRole('combobox', { name: 'Source type' }).selectOption('url');
    await app.page.getByRole('textbox', { name: 'Repo URL' }).fill('https://example.com/acme/reference.git');
    await app.page.getByRole('textbox', { name: 'Source mount name' }).fill('reference');
    await app.page.getByRole('checkbox', { name: 'Read-only source' }).check();
    await app.page.getByRole('button', { name: 'Add source' }).last().click();

    await openSourceEditor(app.page);
    await expect(app.page.getByRole('checkbox', { name: 'Read-only source' })).toBeChecked();
    await app.page.getByRole('button', { name: 'Cancel' }).click();

    const restarted = await app.restart();
    await openProject(restarted, projectName);
    await openSourceEditor(restarted);
    await expect(restarted.getByRole('checkbox', { name: 'Read-only source' })).toBeChecked();
  });
});
