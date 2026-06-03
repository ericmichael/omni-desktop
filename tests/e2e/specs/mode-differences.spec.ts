import { expect, test } from 'tests/e2e/fixtures/test';
import { openSettings } from 'tests/e2e/support/app';

test.describe('mode-specific UI affordances', () => {
  test('shows desktop-only skill install affordance only in Electron', async ({ appPage, mode }) => {
    await openSettings(appPage);
    await appPage.getByRole('button', { name: 'Skills' }).first().click();

    await expect(appPage.getByRole('button', { name: 'Install from marketplace' })).toBeVisible();

    const installFromFile = appPage.getByRole('button', { name: 'Install from file' });
    if (mode === 'electron-local') {
      await expect(installFromFile).toBeVisible();
    } else {
      await expect(installFromFile).toHaveCount(0);
    }
  });
});
