import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofScreenshot } from 'tests/e2e/support/proof';

test.use({ seedState: 'workspace-files' });

test.describe('workspace files', () => {
  test('opens, edits, and explicitly saves a workspace file', async ({ app }, testInfo) => {
    test.setTimeout(180_000);
    const page = app.page;
    const targetPath = path.join(app.workspaceDir, 'src', 'index.ts');
    const updatedContent = "export const greeting = 'updated';\r\nconsole.log(greeting);\r\n";

    const seededSession = page
      .getByRole('tree', { name: 'Sessions' })
      .getByRole('treeitem', { name: /Workspace Files/ });
    await expect(seededSession).toBeVisible({ timeout: 120_000 });
    await seededSession.click();

    const filesButton = page.getByRole('button', { name: 'Files', exact: true });
    await expect(filesButton).toBeVisible({ timeout: 120_000 });
    await filesButton.click();

    const filesSurface = page.locator('section[aria-label="Workspace files"]');
    await expect(filesSurface).toBeVisible({ timeout: 90_000 });
    const tree = filesSurface.getByRole('tree', { name: 'Workspace files' });
    await expect(tree).toBeVisible({ timeout: 90_000 });
    await attachProofScreenshot(filesSurface, testInfo, 'workspace files loaded');

    const sourceFolder = tree.getByRole('treeitem', { name: 'src', exact: true });
    await expect(sourceFolder).toBeVisible();
    await sourceFolder.focus();
    await page.keyboard.press('ArrowRight');

    const sourceFile = tree.getByRole('treeitem', { name: 'index.ts', exact: true });
    await expect(sourceFile).toBeVisible();
    await sourceFile.click();

    const editor = page.getByRole('textbox', { name: 'Editor for src/index.ts' });
    await expect(editor).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Saved src/index.ts' })).toBeVisible();

    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText("export const greeting = 'updated';\nconsole.log(greeting);\n");
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();
    await attachProofScreenshot(filesSurface, testInfo, 'workspace file has unsaved changes');

    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.getByRole('status').filter({ hasText: 'Saved src/index.ts' })).toBeVisible();
    await expect.poll(() => readFileSync(targetPath, 'utf-8')).toBe(updatedContent);
    await attachProofScreenshot(filesSurface, testInfo, 'workspace file saved');
  });
});
