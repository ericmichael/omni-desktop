import { expect, test } from 'tests/e2e/fixtures/test';
import { openChat } from 'tests/e2e/support/app';

test.describe('chat basics', () => {
  test('lets a user compose a message and preserves a safe chat surface after restart', async ({ app }) => {
    const prompt = `E2E chat prompt ${Date.now()}`;

    await openChat(app.page);
    await expect(app.page.getByPlaceholder('How can I help you today?')).toBeVisible();
    await expect(app.page.getByLabel('Attach files')).toBeVisible();

    await app.page.getByPlaceholder('How can I help you today?').fill(prompt);
    await expect(app.page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await app.page.getByRole('button', { name: 'Send' }).click();
    await expect(app.page.getByPlaceholder('How can I help you today?')).toHaveValue('');

    const restarted = await app.restart();
    await openChat(restarted);
    await expect(restarted.getByPlaceholder('How can I help you today?')).toBeVisible();
  });
});
