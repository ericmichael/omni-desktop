import { expect, test } from 'tests/e2e/fixtures/test';

test.describe('app shell', () => {
  test('loads primary navigation and switches core tabs', async ({ appPage, mode }) => {
    await test.step(`verify ${mode} navigation`, async () => {
      await expect(appPage.getByRole('tablist', { name: 'Main navigation' })).toBeVisible();
      await expect(appPage.getByRole('tab', { name: 'Chat' })).toBeVisible();
      await expect(appPage.getByRole('tab', { name: 'Projects' })).toBeVisible();
      await expect(appPage.getByRole('tab', { name: 'Routines' })).toBeVisible();
      await expect(appPage.getByRole('tab', { name: 'Settings' })).toBeVisible();
    });

    await test.step('switch to Projects', async () => {
      await appPage.getByRole('tab', { name: 'Projects' }).click();
      await expect(appPage.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
    });

    await test.step('switch to Settings', async () => {
      await appPage.getByRole('tab', { name: 'Settings' }).click();
      await expect(appPage.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    });

    await test.step('switch to Routines', async () => {
      await appPage.getByRole('tab', { name: 'Routines' }).click();
      await expect(appPage.getByRole('tab', { name: 'Routines' })).toHaveAttribute('aria-selected', 'true');
      await expect(appPage.getByRole('heading', { name: 'Routines' })).toBeVisible();
    });
  });
});
