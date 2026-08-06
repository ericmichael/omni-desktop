import { execFileSync } from 'node:child_process';

import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofScreenshot } from 'tests/e2e/support/proof';

test.use({ seedState: 'workspace-git' });

async function openSourceControl(page: Page) {
  const seededSession = page.getByRole('button', { name: 'Canonical workspace thread', exact: true });
  await expect(seededSession).toBeVisible({ timeout: 120_000 });
  await seededSession.click();

  const gitButton = page.getByRole('button', { name: 'Git', exact: true });
  await expect(gitButton).toBeVisible({ timeout: 120_000 });
  await gitButton.click();

  const sourceControl = page.getByRole('region', { name: 'Source control', exact: true });
  await expect(sourceControl).toBeVisible({ timeout: 90_000 });
  const repository = sourceControl.getByRole('combobox', { name: 'Repository' });
  await expect(repository).toBeVisible();
  await expect(repository).toHaveValue('.');
  return sourceControl;
}

function stagedPaths(workspaceDir: string): string {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workspaceDir, encoding: 'utf-8' }).trim();
}

function latestCommitSubject(workspaceDir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s'], { cwd: workspaceDir, encoding: 'utf-8' }).trim();
}

test.describe('workspace source control', () => {
  test('keeps change review in the repository-scoped Git app', async ({ app }, testInfo) => {
    test.setTimeout(240_000);
    const sourceControl = await openSourceControl(app.page);

    await app.page.getByRole('button', { name: 'Session menu' }).click();
    await expect(app.page.getByRole('menuitem', { name: 'Changes', exact: true })).toHaveCount(0);
    await app.page.keyboard.press('Escape');

    await expect(sourceControl.getByRole('button', { name: 'Working tree', exact: true })).toBeVisible();
    await expect(sourceControl.getByRole('button', { name: 'Apply to local folder', exact: true })).toHaveCount(0);
    await attachProofScreenshot(sourceControl, testInfo, 'repository-scoped source control');
  });

  test('reviews one changed file and stages and unstages that exact file', async ({ app }, testInfo) => {
    test.setTimeout(240_000);
    const sourceControl = await openSourceControl(app.page);

    const changedFile = sourceControl.getByRole('button', { name: 'src/index.ts', exact: true });
    await expect(changedFile).toBeVisible();
    await changedFile.click();

    const diff = sourceControl.getByRole('article', { name: 'Diff for src/index.ts' });
    await expect(diff).toBeVisible();
    await expect(diff).toContainText("export const target = 'after';");
    await attachProofScreenshot(sourceControl, testInfo, 'working tree diff selected');

    await diff.getByRole('button', { name: 'Stage file', exact: true }).click();
    await expect.poll(() => stagedPaths(app.workspaceDir)).toBe('src/index.ts');

    await sourceControl.getByRole('button', { name: 'Staged', exact: true }).click();
    const stagedDiff = sourceControl.getByRole('article', { name: 'Diff for src/index.ts' });
    await expect(stagedDiff).toBeVisible();
    await expect(stagedDiff.getByRole('button', { name: 'Unstage file', exact: true })).toBeVisible();
    await attachProofScreenshot(sourceControl, testInfo, 'exact file staged');

    await stagedDiff.getByRole('button', { name: 'Unstage file', exact: true }).click();
    await expect.poll(() => stagedPaths(app.workspaceDir)).toBe('');
    await sourceControl.getByRole('button', { name: 'Working tree', exact: true }).click();
    await expect(sourceControl.getByRole('article', { name: 'Diff for src/index.ts' })).toBeVisible();
    await attachProofScreenshot(sourceControl, testInfo, 'exact file unstaged');
  });

  test('opens a changed line from the diff in the native Files editor', async ({ app }, testInfo) => {
    test.setTimeout(240_000);
    const page = app.page;
    const sourceControl = await openSourceControl(page);

    await sourceControl.getByRole('button', { name: 'src/index.ts', exact: true }).click();
    const diff = sourceControl.getByRole('article', { name: 'Diff for src/index.ts' });
    await expect(diff).toBeVisible();
    await attachProofScreenshot(sourceControl, testInfo, 'git diff before opening changed line');

    await diff.getByRole('button', { name: 'Open src/index.ts', exact: true }).click();

    const filesSurface = page.getByRole('region', { name: 'Workspace files', exact: true });
    await expect(filesSurface).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Editor for src/index.ts' })).toBeVisible();
    await expect(filesSurface.getByRole('status').filter({ hasText: 'Opened src/index.ts at line 2' })).toBeVisible();
    await expect(filesSurface.locator('.cm-activeLine')).toContainText("export const target = 'after';");
    await attachProofScreenshot(filesSurface, testInfo, 'changed line opened in Files');
  });

  test('commits staged work and refreshes canonical repository history', async ({ app }, testInfo) => {
    test.setTimeout(240_000);
    const sourceControl = await openSourceControl(app.page);

    await sourceControl.getByRole('button', { name: 'src/index.ts', exact: true }).click();
    const diff = sourceControl.getByRole('article', { name: 'Diff for src/index.ts' });
    await diff.getByRole('button', { name: 'Stage file', exact: true }).click();
    await expect.poll(() => stagedPaths(app.workspaceDir)).toBe('src/index.ts');

    await sourceControl.getByRole('button', { name: 'Repository tools', exact: true }).click();
    const commitMessage = 'exercise v2 Git actions';
    await sourceControl.getByRole('textbox', { name: 'Commit message' }).fill(commitMessage);
    await attachProofScreenshot(sourceControl, testInfo, 'v2 repository commit ready');
    await sourceControl.getByRole('button', { name: 'Commit staged changes', exact: true }).click();

    await expect(sourceControl.getByRole('status')).toContainText('Changes committed.');
    await expect.poll(() => latestCommitSubject(app.workspaceDir)).toBe(commitMessage);
    await expect.poll(() => stagedPaths(app.workspaceDir)).toBe('');

    await sourceControl.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(sourceControl.getByText(commitMessage, { exact: true })).toBeVisible();
    await expect(sourceControl.getByText('fixture baseline', { exact: true })).toBeVisible();
    await attachProofScreenshot(sourceControl, testInfo, 'v2 repository history refreshed');
  });
});
