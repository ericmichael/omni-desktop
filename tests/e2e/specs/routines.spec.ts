import { expect, test } from 'tests/e2e/fixtures/test';
import { openRoutines } from 'tests/e2e/support/app';

test.use({ seedState: 'planning' });

test.describe('routines', () => {
  test('creates, edits, pauses, runs, opens, and deletes a desktop scheduled task', async ({ app }) => {
    await openRoutines(app.page);

    await test.step('create routine', async () => {
      await app.page.getByRole('textbox', { name: 'Name' }).fill('E2E morning review');
      await app.page.getByRole('textbox', { name: 'Instructions' }).fill('Summarize the workspace status.');
      await expect(app.page.getByRole('combobox', { name: 'Project' })).toBeVisible();
      await expect(app.page.getByRole('combobox', { name: 'Approvals' })).toHaveValue('ask');
      await expect(app.page.getByText(/Function tools can be always allowed by tool name/)).toBeVisible();
      await expect(
        app.page.getByText(/MCP tools can be always allowed only for a specific server and tool pair/)
      ).toBeVisible();
      await expect(app.page.getByText(/auto[- ]approve all/i)).toHaveCount(0);
      await app.page.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'Seeded Project' });
      await expect(app.page.getByRole('button', { name: /This computer/ })).toBeVisible();
      await app.page.getByRole('button', { name: 'Create routine' }).click();
      await expect(app.page.getByText('E2E morning review')).toBeVisible();
      await expect(app.page.getByText(/Daily at 09:00/)).toBeVisible();
      await expect(app.page.getByLabel('E2E morning review always allowed function tools')).toBeVisible();
      await expect(app.page.getByText('Always allowed function tools')).toBeVisible();
      await expect(app.page.getByText('No function tools are always allowed for this routine.')).toBeVisible();
      await expect(app.page.getByLabel('E2E morning review always allowed MCP tools')).toBeVisible();
      await expect(app.page.getByText('Always allowed MCP tools')).toBeVisible();
      await expect(
        app.page.getByText('MCP approvals are scoped to the exact server label and tool name.')
      ).toBeVisible();
      await expect(
        app.page.getByText('No MCP server and tool pairs are always allowed for this routine.')
      ).toBeVisible();
      await expect(app.page.locator('div').filter({ hasText: /^Seeded Project$/ })).toBeVisible();
      await expect(app.page.getByText('This computer (no sandbox)').first()).toBeVisible();
    });

    await test.step('edit routine', async () => {
      await app.page.getByRole('button', { name: 'Edit' }).click();
      const editPanel = app.page.getByLabel('Edit E2E morning review');
      await expect(editPanel).toBeVisible();
      await expect(editPanel.getByRole('combobox', { name: 'Approvals' })).toHaveValue('ask');
      await expect(editPanel.getByText(/Function tools can be always allowed by tool name/)).toBeVisible();
      await expect(
        editPanel.getByText(/MCP tools can be always allowed only for a specific server and tool pair/)
      ).toBeVisible();
      await expect(editPanel.getByText(/auto[- ]approve all/i)).toHaveCount(0);
      await editPanel.getByRole('textbox', { name: 'Name' }).fill('E2E edited review');
      await editPanel.getByRole('combobox', { name: 'Schedule' }).selectOption('weekly');
      await editPanel.getByLabel('Time').fill('10:30');
      await editPanel.getByRole('combobox', { name: 'Day' }).selectOption('2');
      await editPanel.getByRole('button', { name: 'Save changes' }).click();
      await expect(app.page.getByText('E2E edited review')).toBeVisible();
      await expect(app.page.getByText(/Weekly on Tuesday at 10:30/)).toBeVisible();
      await expect(editPanel).toHaveCount(0);
    });

    await test.step('pause and resume routine', async () => {
      const routineCard = app.page.getByRole('group').filter({ hasText: 'E2E edited review' });
      await routineCard.getByRole('switch', { name: 'Active' }).click();
      await expect(routineCard.getByRole('switch', { name: 'Paused' })).toBeVisible();
      await routineCard.getByRole('switch', { name: 'Paused' }).click();
      await expect(routineCard.getByRole('switch', { name: 'Active' })).toBeVisible();
    });

    await test.step('run manually records launch attempt', async () => {
      await app.page.getByRole('button', { name: 'Run now' }).click();
      await expect(app.page.getByText(/Last (Running|Completed|Failed|Waiting for approval)/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(app.page.getByLabel('E2E edited review recent runs')).toBeVisible();
      await expect(app.page.getByText(/Status: (Running|Completed|Failed|Waiting for approval)/)).toBeVisible();
      await expect(app.page.getByText(/Session:/)).toBeVisible();
      await expect(app.page.getByRole('button', { name: 'Open session' })).toBeVisible();
    });

    await test.step('open run session for review', async () => {
      await app.page.getByRole('button', { name: 'Open session' }).click();
      await expect(app.page.getByRole('tab', { name: 'Spaces' })).toHaveAttribute('aria-selected', 'true');
      await openRoutines(app.page);
    });

    await test.step('delete routine', async () => {
      await app.page.getByRole('button', { name: 'Delete' }).click();
      await expect(app.page.getByText('No routines yet.')).toBeVisible();
    });
  });
});
