import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function openProjects(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
}

export async function createProject(page: Page, projectName: string): Promise<void> {
  await openProjects(page);
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByRole('textbox', { name: 'Project name' }).fill(projectName);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByText(projectName).first()).toBeVisible();
}

export async function openProject(page: Page, projectName: string): Promise<void> {
  await openProjects(page);
  await page.getByText(projectName).first().click();
  await expect(page.getByText(projectName).first()).toBeVisible();
}

export function projectTree(page: Page) {
  return page.getByRole('tree', { name: 'Project tree' });
}

export async function openAddSourceDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Project actions' }).last().click();
  await page.getByRole('menuitem', { name: 'Add source…' }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Add source' })).toBeVisible();
}

export async function addGitSource(page: Page, repoUrl: string, mountName: string): Promise<void> {
  await openAddSourceDialog(page);
  await page.getByRole('combobox', { name: 'Source type' }).selectOption('url');
  await page.getByRole('textbox', { name: 'Repo URL' }).fill(repoUrl);
  await page.getByRole('textbox', { name: 'Source mount name' }).fill(mountName);
  await page.getByRole('button', { name: 'Add source' }).last().click();
  await expect(projectTree(page).getByRole('treeitem', { name: /Sources \(1\)/ })).toBeVisible();
}

export async function createPage(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New page' }).first().click();
  const titleInput = page.getByRole('textbox', { name: 'Page title' });
  await expect(titleInput).toBeVisible();
  await expect(titleInput).toHaveValue('Untitled');
  await titleInput.fill(title);
  await expect(titleInput).toHaveValue(title);
  await titleInput.blur();
  await expect(titleInput).toHaveValue(title);
}

export async function createMilestone(page: Page, title: string): Promise<void> {
  await projectTree(page).getByRole('button', { name: 'Project actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New milestone' }).click();
  const titleInput = page.getByRole('textbox', { name: 'Milestone title' });
  await titleInput.fill(title);
  await expect(titleInput).toHaveValue(title);
  await page.getByRole('button', { name: 'Create Milestone' }).click();
  const board = projectTree(page).getByRole('treeitem', { name: /Board/ });
  await board.focus();
  await page.keyboard.press('ArrowRight');
  await expect(projectTree(page).getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
}

export async function createTicket(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New ticket' }).first().click();
  await page.getByRole('textbox', { name: 'Ticket title' }).fill(title);
  await page.getByRole('button', { name: 'Create Ticket' }).click();
  await expect(page.getByText(title).first()).toBeVisible();
}
