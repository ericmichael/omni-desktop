import { expect, test } from 'tests/e2e/fixtures/test';
import { attachProofPng } from 'tests/e2e/support/proof';

test.use({ seedState: 'workspace-git' });

test.describe('Omniagents v2 session surfaces', () => {
  test('shows one canonical row per session identity', async ({ app }, testInfo) => {
    test.setTimeout(240_000);
    const page = app.page;
    const projectSessions = page.getByRole('list', { name: 'Project sessions' });
    const recents = page.getByRole('list', { name: 'Recents' });

    await expect(projectSessions.getByRole('button', { name: 'Canonical workspace thread', exact: true })).toHaveCount(
      1
    );
    await expect(recents.getByRole('button', { name: 'Retained canonical thread', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(1);
    await attachProofPng(testInfo, 'canonical v2 session listing', await app.captureScreenshot());
  });

  test('changes the conversation model and reasoning effort for the active session', async ({ app }, testInfo) => {
    test.setTimeout(300_000);
    const page = app.page;
    const session = page.getByRole('button', { name: 'Canonical workspace thread', exact: true });
    await expect(session).toBeVisible({ timeout: 120_000 });
    await session.click();

    const model = page.getByRole('button', { name: /GPT 5\.2 E2E/ });
    await expect(model).toBeVisible({ timeout: 180_000 });
    await model.click();
    await expect(page.getByText('Conversation model', { exact: true })).toBeVisible();
    await page.getByRole('menuitemradio', { name: /GPT 5\.2 Mini E2E/ }).click();
    await expect(page.getByRole('button', { name: /GPT 5\.2 Mini E2E/ })).toBeVisible();

    const reasoning = page.getByTitle('Choose reasoning effort for this conversation');
    await expect(reasoning).toContainText('low');
    await reasoning.click();
    await expect(page.getByText('Reasoning effort', { exact: true })).toBeVisible();
    await page.getByRole('menuitemradio', { name: 'high', exact: true }).click();
    await expect(reasoning).toContainText('high');
    await attachProofPng(testInfo, 'v2 model and reasoning controls', await app.captureScreenshot());
  });
});
