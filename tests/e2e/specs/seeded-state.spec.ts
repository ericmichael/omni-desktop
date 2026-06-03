import { expect, test } from 'tests/e2e/fixtures/test';
import { openProject, openProjects, projectTree } from 'tests/e2e/support/app';

test.use({ seedState: 'planning' });

test.describe('deterministic seeded state', () => {
  test('loads seeded project, page, and inbox item', async ({ appPage }) => {
    await openProjects(appPage);
    await expect(appPage.getByText('Seeded Project').first()).toBeVisible();

    await openProject(appPage, 'Seeded Project');
    await expect(projectTree(appPage).getByRole('treeitem', { name: /Pages \(1\)/ })).toBeVisible();

    await appPage.getByText('Inbox').first().click();
    await appPage.getByRole('tab', { name: /Later/ }).click();
    await expect(appPage.getByText('Seeded inbox item')).toBeVisible();
  });
});
