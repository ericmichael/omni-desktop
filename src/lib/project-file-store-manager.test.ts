import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectFileStoreManager,
  type ProjectFileStoreManagerEvents,
} from '@/lib/project-file-store-manager';
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

const T = Date.UTC(2026, 3, 12, 12, 0, 0);

function makeCollector() {
  const c = {
    tickets: [] as Ticket[],
    ticketsRemoved: [] as Array<{ projectId: ProjectId; id: TicketId }>,
    milestones: [] as Milestone[],
    milestonesRemoved: [] as Array<{ projectId: ProjectId; id: MilestoneId }>,
    pages: [] as Array<{ page: Page; body: string }>,
    pagesRemoved: [] as Array<{ projectId: ProjectId; id: PageId }>,
    projectChanges: [] as Project[],
    contextChanges: [] as Array<{ projectId: ProjectId; content: string }>,
    parseErrors: [] as Array<{ filePath: string; message: string }>,
  };
  const events: ProjectFileStoreManagerEvents = {
    onProjectChanged: (p) => c.projectChanges.push(p),
    onTicketChanged: (t) => c.tickets.push(t),
    onTicketRemoved: (projectId, id) => c.ticketsRemoved.push({ projectId, id }),
    onMilestoneChanged: (m) => c.milestones.push(m),
    onMilestoneRemoved: (projectId, id) => c.milestonesRemoved.push({ projectId, id }),
    onPageChanged: (page, body) => c.pages.push({ page, body }),
    onPageRemoved: (projectId, id) => c.pagesRemoved.push({ projectId, id }),
    onContextChanged: (projectId, content) => c.contextChanges.push({ projectId, content }),
    onParseError: (filePath, error) => c.parseErrors.push({ filePath, message: error.message }),
  };
  return { ...c, events };
}

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1' as ProjectId,
  label: 'Project One',
  slug: 'project-one',
  createdAt: T,
  ...overrides,
});

const makeTicket = (projectId: ProjectId, overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1' as TicketId,
  projectId,
  title: 'Ticket One',
  description: '',
  priority: 'medium',
  blockedBy: [],
  columnId: 'backlog',
  createdAt: T,
  updatedAt: T,
  comments: [],
  runs: [],
  ...overrides,
});

const makeMilestone = (projectId: ProjectId, overrides: Partial<Milestone> = {}): Milestone => ({
  id: 'm1' as MilestoneId,
  projectId,
  title: 'Milestone One',
  description: 'desc',
  status: 'active',
  createdAt: T,
  updatedAt: T,
  ...overrides,
});

const makePage = (projectId: ProjectId, overrides: Partial<Page> = {}): Page => ({
  id: 'pg1' as PageId,
  projectId,
  parentId: null,
  title: 'Page One',
  sortOrder: 0,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});

let root: string;
let manager: ProjectFileStoreManager;
let collector: ReturnType<typeof makeCollector>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pfsmgr-'));
  collector = makeCollector();
  manager = new ProjectFileStoreManager(collector.events);
});

afterEach(async () => {
  await manager.close();
  await rm(root, { recursive: true, force: true });
});

describe('createProject + lifecycle', () => {
  it('creates a new project folder with project.yml', async () => {
    const proj = makeProject();
    const dir = path.join(root, 'project-one');
    await manager.createProject(proj, dir);
    expect(manager.hasProject(proj.id)).toBe(true);
    expect(manager.getProjectDir(proj.id)).toBe(path.resolve(dir));
    expect(manager.getProject(proj.id)?.label).toBe('Project One');
  });

  it('open() is idempotent over repeated refs', async () => {
    const proj = makeProject();
    const dir = path.join(root, 'project-one');
    await manager.createProject(proj, dir);
    await manager.open([{ id: proj.id, dir }]);
    expect(manager.listProjects()).toHaveLength(1);
  });

  it('removeProject drops the project from the index', async () => {
    const proj = makeProject();
    const dir = path.join(root, 'project-one');
    await manager.createProject(proj, dir);
    await manager.writeTicket(makeTicket(proj.id));
    await manager.removeProject(proj.id);
    expect(manager.hasProject(proj.id)).toBe(false);
    expect(manager.getTicket('t1' as TicketId)).toBeNull();
  });

  it('removeProject with deleteFiles wipes the folder', async () => {
    const proj = makeProject();
    const dir = path.join(root, 'project-one');
    await manager.createProject(proj, dir);
    await manager.removeProject(proj.id, { deleteFiles: true });
    const { access } = await import('fs/promises');
    await expect(access(dir)).rejects.toThrow();
  });
});

describe('cross-project indexing', () => {
  beforeEach(async () => {
    const p1 = makeProject({ id: 'p1' as ProjectId, slug: 'one' });
    const p2 = makeProject({ id: 'p2' as ProjectId, slug: 'two', label: 'Project Two' });
    await manager.createProject(p1, path.join(root, 'one'));
    await manager.createProject(p2, path.join(root, 'two'));
    await manager.writeTicket(makeTicket('p1' as ProjectId, { id: 't-a' as TicketId, title: 'A' }));
    await manager.writeTicket(makeTicket('p1' as ProjectId, { id: 't-b' as TicketId, title: 'B' }));
    await manager.writeTicket(makeTicket('p2' as ProjectId, { id: 't-c' as TicketId, title: 'C' }));
    await manager.writeMilestone(makeMilestone('p2' as ProjectId, { id: 'm-a' as MilestoneId }));
    await manager.writePage(makePage('p1' as ProjectId, { id: 'pg-a' as PageId }), 'body');
  });

  it('listTickets() returns every project ticket when unscoped', () => {
    expect(manager.listTickets()).toHaveLength(3);
  });

  it('listTickets(projectId) scopes to one project', () => {
    expect(manager.listTickets('p1' as ProjectId)).toHaveLength(2);
    expect(manager.listTickets('p2' as ProjectId)).toHaveLength(1);
  });

  it('getTicket resolves cross-project without a project hint', () => {
    expect(manager.getTicket('t-c' as TicketId)?.projectId).toBe('p2');
    expect(manager.getTicket('missing' as TicketId)).toBeNull();
  });

  it('listMilestones and listPages also aggregate and scope', () => {
    expect(manager.listMilestones()).toHaveLength(1);
    expect(manager.listMilestones('p1' as ProjectId)).toEqual([]);
    expect(manager.listPages()).toHaveLength(1);
    expect(manager.listPages('p1' as ProjectId)).toHaveLength(1);
  });

  it('appendTicketComment routes to the owning project', async () => {
    await manager.appendTicketComment('t-c' as TicketId, {
      id: 'c1',
      author: 'agent',
      content: 'hi',
      createdAt: T,
    });
    expect(manager.getTicket('t-c' as TicketId)?.comments).toHaveLength(1);
  });

  it('writeTicket rejects an unknown projectId', async () => {
    await expect(
      manager.writeTicket(makeTicket('ghost' as ProjectId, { id: 't-ghost' as TicketId }))
    ).rejects.toThrow(/unknown project/);
  });

  it('deleteTicket removes from the reverse index', async () => {
    await manager.deleteTicket('t-a' as TicketId);
    expect(manager.getTicket('t-a' as TicketId)).toBeNull();
    expect(manager.listTickets('p1' as ProjectId)).toHaveLength(1);
  });
});

describe('event routing', () => {
  it('forwards ticket write echoes through suppression (no spurious events)', async () => {
    const proj = makeProject();
    await manager.createProject(proj, path.join(root, 'project-one'));
    const before = collector.tickets.length;
    await manager.writeTicket(makeTicket(proj.id));
    await new Promise((r) => setTimeout(r, 400));
    expect(collector.tickets.length).toBe(before);
  });

  it('surfaces parse errors through the aggregated stream', async () => {
    const proj = makeProject();
    const dir = path.join(root, 'project-one');
    await manager.createProject(proj, dir);
    const { writeFile, mkdir } = await import('fs/promises');
    await mkdir(path.join(dir, 'tickets'), { recursive: true });
    await writeFile(path.join(dir, 'tickets', 'broken.md'), '---\ntitle: Only\n---\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(collector.parseErrors.length).toBeGreaterThanOrEqual(1);
  });
});
