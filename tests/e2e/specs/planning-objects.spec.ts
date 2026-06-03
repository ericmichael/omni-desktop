import { expect, test } from 'tests/e2e/fixtures/test';
import { createMilestone, createPage, createProject, openProject } from 'tests/e2e/support/app';

test.describe('planning objects', () => {
  test('creates project pages, milestones, and a first ticket shell', async ({ appPage }) => {
    const projectName = 'E2E Planning Project';

    await createProject(appPage, projectName);
    await openProject(appPage, projectName);

    await createPage(appPage, 'E2E Project Spec');
    await createMilestone(appPage, 'E2E Milestone');

    await test.step('create a ticket from the project board', async () => {
      await appPage.getByRole('treeitem', { name: /Board/ }).click();
      await appPage.getByRole('button', { name: 'New', exact: true }).first().click();
      await expect(appPage.getByRole('button', { name: 'Untitled' })).toBeVisible();
    });
  });
});
