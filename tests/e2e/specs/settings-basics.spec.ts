import { expect, test } from 'tests/e2e/fixtures/test';
import { openSettings } from 'tests/e2e/support/app';

test.describe('settings basics', () => {
  test('exposes core configuration areas without leaking seeded secrets', async ({ app }) => {
    await openSettings(app.page);

    for (const section of ['General', 'Environment', 'Models', 'MCP Servers', 'Git', 'Skills', 'Network']) {
      await test.step(`open ${section}`, async () => {
        await app.page.getByRole('button', { name: section }).first().click();
        await expect(app.page.getByText(section).first()).toBeVisible();
      });
    }

    await test.step('raw seeded secrets are not rendered', async () => {
      await expect(app.page.getByText('test-key', { exact: true })).toHaveCount(0);
      await expect(
        app.page.getByText(process.env.OPENAI_API_KEY ?? process.env.SANDBOX_OPENAI_API_KEY ?? 'test-key')
      ).toHaveCount(0);
    });

    const restarted = await app.restart();
    await openSettings(restarted);
    await expect(restarted.getByRole('button', { name: 'Models' }).first()).toBeVisible();
    await expect(restarted.getByRole('button', { name: 'Git' }).first()).toBeVisible();
  });
});
