import { expect, test } from 'tests/e2e/fixtures/test';
import { addGitSource, createProject, openAddSourceDialog, openProject } from 'tests/e2e/support/app';

test.describe('projects and sources', () => {
  test('creates a project and adds a git source from the UI', async ({ appPage }) => {
    const projectName = 'E2E Source Project';

    await createProject(appPage, projectName);
    await openProject(appPage, projectName);
    await addGitSource(appPage, 'https://github.com/example/e2e-source-project.git', 'e2e-source-project');

    await test.step('reject duplicate source metadata', async () => {
      await openAddSourceDialog(appPage);
      await appPage.getByRole('combobox', { name: 'Source type' }).selectOption('url');
      await appPage
        .getByRole('textbox', { name: 'Repo URL' })
        .fill('https://github.com/example/e2e-source-project.git');
      await appPage.getByRole('textbox', { name: 'Source mount name' }).fill('e2e-source-project');
      await appPage.getByRole('button', { name: 'Add source' }).last().click();
      await expect(appPage.getByRole('alert')).toBeVisible();
    });
  });
});
