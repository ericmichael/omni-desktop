import { expect, test } from 'tests/e2e/fixtures/test';
import { createProject, createTicket, openProject, openTicket } from 'tests/e2e/support/app';

test.describe('ticket lifecycle', () => {
  test('creates, edits, comments on, moves, and persists a ticket', async ({ app }) => {
    const projectName = `E2E Ticket Project ${Date.now()}`;
    const ticketTitle = `E2E Ticket ${Date.now()}`;
    const renamedTitle = `${ticketTitle} Updated`;
    const description = 'Ticket description added from the user-facing overview.';
    const comment = 'Ticket discussion comment from E2E.';

    await createProject(app.page, projectName);
    await openProject(app.page, projectName);
    await createTicket(app.page, ticketTitle);
    await openTicket(app.page, ticketTitle);

    await app.page.getByRole('button', { name: new RegExp(ticketTitle) }).click();
    await app.page.getByRole('textbox').first().fill(renamedTitle);
    await app.page.keyboard.press('Enter');
    await expect(app.page.getByRole('button', { name: new RegExp(renamedTitle) })).toBeVisible();

    await app.page.getByRole('button', { name: 'Edit description' }).click();
    await app.page.getByPlaceholder('Ticket description...').fill(description);
    await app.page.getByRole('button', { name: 'Save' }).click();
    await expect(app.page.getByText(description)).toBeVisible();

    await app.page.locator('select').nth(1).selectOption('high');
    await app.page.locator('select').first().selectOption({ label: 'Review' });
    await expect(app.page.locator('select').first()).toHaveValue(/review/);

    await app.page.getByRole('tab', { name: 'Discussion' }).click();
    await app.page.getByPlaceholder('Add a comment...').fill(comment);
    await app.page.getByRole('button', { name: 'Send comment' }).click();
    await expect(app.page.getByText(comment)).toBeVisible();

    const restarted = await app.restart();
    await openProject(restarted, projectName);
    await openTicket(restarted, renamedTitle);
    await expect(restarted.getByText(description)).toBeVisible();
    await expect(restarted.locator('select').first()).toHaveValue(/review/);
    await restarted.getByRole('tab', { name: 'Discussion' }).click();
    await expect(restarted.getByText(comment)).toBeVisible();
  });
});
