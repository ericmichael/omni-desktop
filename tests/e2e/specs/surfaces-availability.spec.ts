import { expect, test } from 'tests/e2e/fixtures/test';
import { createProject, openChat, openCode, openProject, openSettings } from 'tests/e2e/support/app';

test.describe('surfaces availability', () => {
  test('keeps primary user surfaces reachable and mode-appropriate', async ({ appPage, mode }) => {
    await openChat(appPage);
    await expect(appPage.getByPlaceholder('How can I help you today?')).toBeVisible();

    await openCode(appPage);
    await expect(appPage.getByText(/Spaces|No apps installed|Chat|Browser|Settings/).first()).toBeVisible();

    await openSettings(appPage);
    await appPage.getByRole('button', { name: 'Skills' }).first().click();
    await expect(appPage.getByRole('button', { name: 'Install from marketplace' })).toBeVisible();
    const installFromFile = appPage.getByRole('button', { name: 'Install from file' });
    if (mode === 'electron-local') {
      await expect(installFromFile).toBeVisible();
    } else {
      await expect(installFromFile).toHaveCount(0);
    }

    const projectName = `E2E Surface Project ${Date.now()}`;
    await createProject(appPage, projectName);
    await openProject(appPage, projectName);
    await expect(appPage.getByRole('tree', { name: 'Project tree' })).toBeVisible();
    await expect(appPage.getByRole('button', { name: 'New page' }).first()).toBeVisible();
    await appPage.getByRole('treeitem', { name: /Board/ }).click();
    await expect(appPage.getByRole('button', { name: 'New', exact: true }).first()).toBeVisible();
  });
});
