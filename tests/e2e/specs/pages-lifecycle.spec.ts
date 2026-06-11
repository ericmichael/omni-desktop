import { expect, test } from 'tests/e2e/fixtures/test';
import { createPage, createProject, openProject, projectTree } from 'tests/e2e/support/app';
import { attachProofScreenshot } from 'tests/e2e/support/proof';

test.describe('pages lifecycle', () => {
  test('creates, renames, navigates, and persists project pages', async ({ app }, testInfo) => {
    const projectName = `E2E Pages Project ${Date.now()}`;
    const pageTitle = `E2E Spec ${Date.now()}`;
    const renamedTitle = `${pageTitle} Updated`;

    await createProject(app.page, projectName);
    await openProject(app.page, projectName);
    await createPage(app.page, pageTitle);

    const titleInput = app.page.getByRole('textbox', { name: 'Page title' });
    await expect(titleInput).toHaveValue(pageTitle);
    await titleInput.fill(renamedTitle);
    await titleInput.blur();
    await expect(titleInput).toHaveValue(renamedTitle);
    await attachProofScreenshot(app.page, testInfo, 'pages-lifecycle-editor', { fullPage: true });

    await app.page.getByRole('button', { name: 'Back' }).click();
    const pagesGroup = projectTree(app.page).getByRole('treeitem', { name: /Pages \(1\)/ });
    await expect(pagesGroup).toBeVisible();
    await pagesGroup.focus();
    await app.page.keyboard.press('ArrowRight');
    await expect(projectTree(app.page).getByRole('treeitem', { name: new RegExp(renamedTitle) })).toBeVisible();
    await attachProofScreenshot(app.page, testInfo, 'pages-lifecycle-tree', { fullPage: true });

    const restarted = await app.restart();
    await openProject(restarted, projectName);
    const restartedPagesGroup = projectTree(restarted).getByRole('treeitem', { name: /Pages \(1\)/ });
    await expect(restartedPagesGroup).toBeVisible();
    await restartedPagesGroup.focus();
    await restarted.keyboard.press('ArrowRight');
    await expect(projectTree(restarted).getByRole('treeitem', { name: new RegExp(renamedTitle) })).toBeVisible();
  });
});
