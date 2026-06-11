import { expect, test } from 'tests/e2e/fixtures/test';
import { addInboxItem, createProject, openInbox, openProject } from 'tests/e2e/support/app';

test.describe('inbox lifecycle', () => {
  test('captures, shapes, defers, reactivates, and promotes an inbox item', async ({ appPage }) => {
    const projectName = `E2E Inbox Project ${Date.now()}`;
    const itemTitle = `E2E Inbox Item ${Date.now()}`;
    const outcome = 'Inbox item is shaped and ready for implementation.';

    await createProject(appPage, projectName);
    await addInboxItem(appPage, itemTitle);
    const inboxRow = appPage.getByRole('button', { name: new RegExp(itemTitle) });
    await inboxRow.focus();
    await appPage.keyboard.press('Enter');
    await expect(appPage.getByLabel('Outcome — what does success look like?')).toBeVisible();

    await appPage.getByLabel('Outcome — what does success look like?').fill(outcome);
    await appPage.getByLabel('Outcome — what does success look like?').blur();
    await expect(appPage.getByText('Shaped', { exact: true }).first()).toBeVisible();

    await appPage.getByRole('button', { name: 'More actions' }).click();
    await appPage.getByRole('menuitem', { name: 'Defer to later' }).click();
    await expect(appPage.getByText('Later')).toBeVisible();

    await appPage.getByRole('button', { name: 'More actions' }).click();
    await appPage.getByRole('menuitem', { name: 'Reactivate' }).click();
    await expect(appPage.getByText('Shaped', { exact: true }).first()).toBeVisible();

    await expect(appPage.getByLabel('Outcome — what does success look like?')).toBeVisible();
    await appPage.locator('select').selectOption({ label: projectName });
    const promoteToTicket = appPage.getByRole('button', { name: 'Promote to ticket' });
    await expect(promoteToTicket).toBeVisible();
    await promoteToTicket.click();

    await openProject(appPage, projectName);
    await appPage.getByRole('treeitem', { name: /Board/ }).click();
    await expect(appPage.getByText(itemTitle).first()).toBeVisible();

    await openInbox(appPage);
    await appPage.getByRole('tab', { name: /Archive/ }).click();
    await expect(appPage.getByText(itemTitle).first()).toBeVisible();
  });
});
