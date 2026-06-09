import type { Page } from '@playwright/test';
import { expect, test } from 'tests/e2e/fixtures/test';
import { addGitSource, createProject, openPipelineSettings, openProject } from 'tests/e2e/support/app';

async function ensureImplementationColumn(page: Page): Promise<void> {
  await openPipelineSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Pipeline Settings' });
  if ((await dialog.getByRole('button', { name: 'Implementation' }).count()) === 0) {
    await dialog.getByPlaceholder('Add column...').fill('Implementation');
    await dialog.getByRole('button', { name: 'Add column' }).click();
    await dialog.getByRole('button', { name: /Save/ }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    return;
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function setImplementationDefinitionOfDone(page: Page, text: string): Promise<void> {
  await openPipelineSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Pipeline Settings' });
  await dialog.getByLabel('Definition of done for Implementation').fill(text);
  await dialog.getByRole('button', { name: /Save/ }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function expectImplementationDefinitionOfDone(page: Page, text: string): Promise<void> {
  await openPipelineSettings(page);
  const dialog = page.getByRole('dialog', { name: 'Pipeline Settings' });
  await expect(dialog.getByLabel('Definition of done for Implementation')).toHaveValue(text);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

test.describe('pipeline settings', () => {
  test('persists the Implementation definition of done edited in settings', async ({ app }) => {
    const projectName = `E2E Pipeline Project ${Date.now()}`;
    const mountName = `e2e-pipeline-source-${Date.now()}`;
    const definitionOfDone = `Implementation verifies DB-backed workflow contracts ${Date.now()}.`;

    await createProject(app.page, projectName);
    await openProject(app.page, projectName);
    await addGitSource(app.page, 'https://github.com/example/e2e-pipeline-source.git', mountName);
    await ensureImplementationColumn(app.page);

    await setImplementationDefinitionOfDone(app.page, definitionOfDone);
    await expectImplementationDefinitionOfDone(app.page, definitionOfDone);

    const restarted = await app.restart();
    await openProject(restarted, projectName);
    await expectImplementationDefinitionOfDone(restarted, definitionOfDone);
  });
});
