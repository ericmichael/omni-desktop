import { mkdir,mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateStoreV13, type MigrationInput } from '@/lib/migrate-v13';
import { ProjectFileStore, type ProjectFileStoreEvents } from '@/lib/project-file-store';
import type {
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Project,
  ProjectId,
  Ticket,
  TicketId,
} from '@/shared/types';

const T1 = Date.UTC(2026, 3, 10, 9, 0, 0);
const T2 = Date.UTC(2026, 3, 11, 10, 0, 0);

const noopEvents: ProjectFileStoreEvents = {
  onProjectChanged: () => {},
  onTicketChanged: () => {},
  onTicketRemoved: () => {},
  onMilestoneChanged: () => {},
  onMilestoneRemoved: () => {},
  onPageChanged: () => {},
  onPageRemoved: () => {},
  onContextChanged: () => {},
  onParseError: () => {},
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'migrate-v13-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const projectDirFor = (project: Project) => path.join(root, project.slug);

function fixture(): MigrationInput {
  const proj1: Project = {
    id: 'p1' as ProjectId,
    label: 'Launcher',
    slug: 'launcher',
    createdAt: T1,
    pipeline: {
      columns: [
        { id: 'backlog', label: 'Backlog' },
        { id: 'doing', label: 'Doing' },
      ],
    },
  };
  const proj2: Project = {
    id: 'p2' as ProjectId,
    label: 'Personal',
    slug: 'personal',
    isPersonal: true,
    createdAt: T1,
  };
  const tickets: Ticket[] = [
    {
      id: 't1' as TicketId,
      projectId: proj1.id,
      title: 'Fix login',
      description: 'The redirect is broken.',
      priority: 'high',
      blockedBy: [],
      columnId: 'doing',
      createdAt: T1,
      updatedAt: T2,
      comments: [
        { id: 'c1', author: 'agent', content: 'Found it', createdAt: T1 },
        { id: 'c2', author: 'human', content: 'Ship it', createdAt: T2 },
      ],
      runs: [{ id: 'r1', startedAt: T1, endedAt: T2, endReason: 'completed' }],
    },
    {
      id: 't2' as TicketId,
      projectId: proj1.id,
      title: 'Docs',
      description: '',
      priority: 'low',
      blockedBy: [],
      columnId: 'backlog',
      createdAt: T1,
      updatedAt: T1,
    },
  ];
  const milestones: Milestone[] = [
    {
      id: 'm1' as MilestoneId,
      projectId: proj1.id,
      title: 'Auth',
      description: 'Session to JWT',
      status: 'active',
      brief: 'Full brief here.',
      createdAt: T1,
      updatedAt: T2,
    },
  ];
  const pages: Page[] = [
    {
      id: 'root-1' as PageId,
      projectId: proj1.id,
      parentId: null,
      title: 'Launcher',
      sortOrder: 0,
      isRoot: true,
      createdAt: T1,
      updatedAt: T1,
    },
    {
      id: 'pg-1' as PageId,
      projectId: proj1.id,
      parentId: null,
      title: 'Design notes',
      sortOrder: 1,
      properties: { status: 'ready', outcome: 'Agree on data model' },
      createdAt: T1,
      updatedAt: T2,
    },
    {
      id: 'pg-inbox' as PageId,
      projectId: proj2.id,
      parentId: null,
      title: 'Call mom',
      sortOrder: 1,
      properties: { status: 'new' },
      createdAt: T1,
      updatedAt: T1,
    },
  ];
  return { projects: [proj1, proj2], tickets, milestones, pages };
}

describe('migrateStoreV13', () => {
  it('writes the full file layout for every project', async () => {
    const input = fixture();
    const summary = await migrateStoreV13(input, { resolveProjectDir: projectDirFor });

    expect(summary).toEqual({
      projectsWritten: 2,
      ticketsWritten: 2,
      milestonesWritten: 1,
      pagesWritten: 2,
      commentsWritten: 2,
      runsWritten: 1,
      skippedRootPages: 1,
      contextFilesCreated: 2,
    });

    const launcherDir = path.join(root, 'launcher');
    expect(await readFile(path.join(launcherDir, '.omni', 'project.yml'), 'utf-8')).toContain('label: Launcher');
    expect(await readFile(path.join(launcherDir, 'context.md'), 'utf-8')).toContain('# Launcher');
    expect(await readFile(path.join(launcherDir, 'tickets', 't1.md'), 'utf-8')).toContain('title: Fix login');
    expect(await readFile(path.join(launcherDir, 'tickets', 't1.comments.jsonl'), 'utf-8')).toContain('Found it');
    expect(await readFile(path.join(launcherDir, 'tickets', 't1.runs.jsonl'), 'utf-8')).toContain('completed');
    expect(await readFile(path.join(launcherDir, 'milestones', 'm1.md'), 'utf-8')).toContain('Auth');
    expect(await readFile(path.join(launcherDir, 'pages', 'pg-1.md'), 'utf-8')).toContain('Design notes');
  });

  it('roundtrips through ProjectFileStore — data fully recoverable after migration', async () => {
    const input = fixture();
    await migrateStoreV13(input, { resolveProjectDir: projectDirFor });

    const launcherDir = path.join(root, 'launcher');
    const store = new ProjectFileStore(launcherDir, 'p1' as ProjectId, noopEvents);
    await store.open();

    expect(store.getProject()?.label).toBe('Launcher');
    expect(store.getProject()?.pipeline?.columns).toHaveLength(2);

    const tickets = store.listTickets();
    expect(tickets).toHaveLength(2);
    const t1 = tickets.find((t) => t.id === 't1');
    expect(t1?.title).toBe('Fix login');
    expect(t1?.description).toBe('The redirect is broken.');
    expect(t1?.columnId).toBe('doing');
    expect(t1?.comments).toHaveLength(2);
    expect(t1?.runs).toHaveLength(1);
    expect(t1?.runs?.[0]?.endReason).toBe('completed');

    const milestones = store.listMilestones();
    expect(milestones).toHaveLength(1);
    expect(milestones[0]?.brief).toBe('Full brief here.');

    const pages = store.listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe('Design notes');
    expect(pages[0]?.properties?.status).toBe('ready');

    await store.close();
  });

  it('skips root pages and does not create files for them', async () => {
    const input = fixture();
    await migrateStoreV13(input, { resolveProjectDir: projectDirFor });
    const rootPagePath = path.join(root, 'launcher', 'pages', 'root-1.md');
    await expect(readFile(rootPagePath, 'utf-8')).rejects.toThrow();
  });

  it('preserves an existing context.md and does not count it as created', async () => {
    const input = fixture();
    const launcherDir = path.join(root, 'launcher');
    await mkdir(launcherDir, { recursive: true });
    await writeFile(path.join(launcherDir, 'context.md'), '# My handwritten brief\n\nOld content.\n');

    const summary = await migrateStoreV13(input, { resolveProjectDir: projectDirFor });
    expect(summary.contextFilesCreated).toBe(1); // only the personal project's
    const text = await readFile(path.join(launcherDir, 'context.md'), 'utf-8');
    expect(text).toContain('My handwritten brief');
  });

  it('wraps an existing plain-markdown page body in frontmatter without losing content', async () => {
    const input = fixture();
    const pageDir = path.join(root, 'launcher', 'pages');
    await mkdir(pageDir, { recursive: true });
    await writeFile(path.join(pageDir, 'pg-1.md'), '## Notes\n\nLots of existing content.\n');

    await migrateStoreV13(input, { resolveProjectDir: projectDirFor });

    const text = await readFile(path.join(pageDir, 'pg-1.md'), 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('title: Design notes');
    expect(text).toContain('## Notes');
    expect(text).toContain('Lots of existing content.');
  });

  it('writes empty projects fine', async () => {
    const summary = await migrateStoreV13(
      { projects: [], tickets: [], milestones: [], pages: [] },
      { resolveProjectDir: projectDirFor }
    );
    expect(summary).toEqual({
      projectsWritten: 0,
      ticketsWritten: 0,
      milestonesWritten: 0,
      pagesWritten: 0,
      commentsWritten: 0,
      runsWritten: 0,
      skippedRootPages: 0,
      contextFilesCreated: 0,
    });
  });

  it('scopes tickets, milestones, and pages to their owning project', async () => {
    const input = fixture();
    await migrateStoreV13(input, { resolveProjectDir: projectDirFor });

    const personalStore = new ProjectFileStore(path.join(root, 'personal'), 'p2' as ProjectId, noopEvents);
    await personalStore.open();
    expect(personalStore.listTickets()).toEqual([]);
    expect(personalStore.listMilestones()).toEqual([]);
    expect(personalStore.listPages()).toHaveLength(1);
    expect(personalStore.listPages()[0]?.title).toBe('Call mom');
    await personalStore.close();
  });
});
