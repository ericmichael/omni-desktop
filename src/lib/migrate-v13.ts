/**
 * v12 → v13 migration: move project data from electron-store to the
 * file-backed layout enforced by ProjectFileStore.
 *
 * The migration is pure data movement — it reads an in-memory snapshot of
 * the old store, writes files into each project's resolved directory, and
 * returns a summary. Responsibility for clearing the moved fields out of
 * electron-store belongs to the caller (so a crash mid-migration leaves
 * the data recoverable from the store on next launch).
 *
 * The existing v10/v12 migrations already populated `<projectDir>/context.md`
 * and `<projectDir>/pages/<id>.md` as plain markdown. This migration
 * preserves those bodies when it rewrites pages with frontmatter.
 */

import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';

import {
  serializeMilestoneFile,
  serializePageFile,
  serializeProjectConfig,
  serializeTicketComment,
  serializeTicketFile,
  serializeTicketRun,
} from '@/lib/project-files';
import type { Milestone, Page, Project, Ticket } from '@/shared/types';

export interface MigrationInput {
  projects: Project[];
  tickets: Ticket[];
  milestones: Milestone[];
  pages: Page[];
}

export interface MigrationSummary {
  projectsWritten: number;
  ticketsWritten: number;
  milestonesWritten: number;
  pagesWritten: number;
  commentsWritten: number;
  runsWritten: number;
  skippedRootPages: number;
  contextFilesCreated: number;
}

export interface MigrationOptions {
  /** Given a project, return the directory that will hold its file-backed data. */
  resolveProjectDir: (project: Project) => string;
}

const emptySummary = (): MigrationSummary => ({
  projectsWritten: 0,
  ticketsWritten: 0,
  milestonesWritten: 0,
  pagesWritten: 0,
  commentsWritten: 0,
  runsWritten: 0,
  skippedRootPages: 0,
  contextFilesCreated: 0,
});

export async function migrateStoreV13(
  input: MigrationInput,
  options: MigrationOptions
): Promise<MigrationSummary> {
  const summary = emptySummary();
  for (const project of input.projects) {
    const dir = options.resolveProjectDir(project);
    await writeProjectFiles(dir, project, input, summary);
  }
  return summary;
}

async function writeProjectFiles(
  dir: string,
  project: Project,
  input: MigrationInput,
  summary: MigrationSummary
): Promise<void> {
  const omniDir = path.join(dir, '.omni');
  const ticketsDir = path.join(dir, 'tickets');
  const milestonesDir = path.join(dir, 'milestones');
  const pagesDir = path.join(dir, 'pages');
  const contextFile = path.join(dir, 'context.md');

  for (const d of [omniDir, ticketsDir, milestonesDir, pagesDir]) {
    await mkdir(d, { recursive: true });
  }

  await writeFile(path.join(omniDir, 'project.yml'), serializeProjectConfig(project), 'utf-8');
  summary.projectsWritten++;

  // Preserve pre-existing context.md from the v10 migration. If missing,
  // seed a stub so the file-store invariant holds.
  const hasContext = await exists(contextFile);
  if (!hasContext) {
    await writeFile(contextFile, `# ${project.label}\n`, 'utf-8');
    summary.contextFilesCreated++;
  }

  const projectTickets = input.tickets.filter((t) => t.projectId === project.id);
  for (const ticket of projectTickets) {
    await writeFile(
      path.join(ticketsDir, `${ticket.id}.md`),
      serializeTicketFile(ticket),
      'utf-8'
    );
    summary.ticketsWritten++;

    if (ticket.comments && ticket.comments.length > 0) {
      const text = ticket.comments.map(serializeTicketComment).join('');
      await writeFile(path.join(ticketsDir, `${ticket.id}.comments.jsonl`), text, 'utf-8');
      summary.commentsWritten += ticket.comments.length;
    }
    if (ticket.runs && ticket.runs.length > 0) {
      const text = ticket.runs.map(serializeTicketRun).join('');
      await writeFile(path.join(ticketsDir, `${ticket.id}.runs.jsonl`), text, 'utf-8');
      summary.runsWritten += ticket.runs.length;
    }
  }

  const projectMilestones = input.milestones.filter((m) => m.projectId === project.id);
  for (const m of projectMilestones) {
    await writeFile(path.join(milestonesDir, `${m.id}.md`), serializeMilestoneFile(m), 'utf-8');
    summary.milestonesWritten++;
  }

  // Root pages (is_root=true) are NOT persisted as files — context.md plays
  // that role in the new model. Skip them; everything else rewrites its
  // existing on-disk body with the new frontmatter format.
  const projectPages = input.pages.filter((p) => p.projectId === project.id);
  for (const p of projectPages) {
    if (p.isRoot) {
      summary.skippedRootPages++;
      continue;
    }
    const pageFile = path.join(pagesDir, `${p.id}.md`);
    let body = '';
    try {
      body = await readFile(pageFile, 'utf-8');
    } catch {
      // fresh page with no on-disk body yet
    }
    await writeFile(pageFile, serializePageFile(p, body), 'utf-8');
    summary.pagesWritten++;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
