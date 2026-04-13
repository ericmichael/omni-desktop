import { mkdtemp, readFile, rm, writeFile, mkdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProjectFileError } from '@/lib/project-files';
import { ProjectFileStore, type ProjectFileStoreEvents } from '@/lib/project-file-store';
import type {
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Project,
  ProjectId,
  Ticket,
  TicketComment,
  TicketId,
  TicketRun,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-test' as ProjectId;
const T1 = Date.UTC(2026, 3, 12, 14, 0, 0);
const T2 = Date.UTC(2026, 3, 12, 15, 30, 0);

interface Collector {
  events: ProjectFileStoreEvents;
  tickets: Ticket[];
  ticketsRemoved: TicketId[];
  milestones: Milestone[];
  milestonesRemoved: MilestoneId[];
  pages: Array<{ page: Page; body: string }>;
  pagesRemoved: PageId[];
  projectChanges: Project[];
  contextChanges: string[];
  parseErrors: Array<{ filePath: string; error: ProjectFileError }>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

function makeCollector(): Collector {
  const c: Omit<Collector, 'events' | 'waitFor'> = {
    tickets: [],
    ticketsRemoved: [],
    milestones: [],
    milestonesRemoved: [],
    pages: [],
    pagesRemoved: [],
    projectChanges: [],
    contextChanges: [],
    parseErrors: [],
  };
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((fn) => fn());
  const events: ProjectFileStoreEvents = {
    onProjectChanged: (p) => {
      c.projectChanges.push(p);
      notify();
    },
    onTicketChanged: (t) => {
      c.tickets.push(t);
      notify();
    },
    onTicketRemoved: (id) => {
      c.ticketsRemoved.push(id);
      notify();
    },
    onMilestoneChanged: (m) => {
      c.milestones.push(m);
      notify();
    },
    onMilestoneRemoved: (id) => {
      c.milestonesRemoved.push(id);
      notify();
    },
    onPageChanged: (page, body) => {
      c.pages.push({ page, body });
      notify();
    },
    onPageRemoved: (id) => {
      c.pagesRemoved.push(id);
      notify();
    },
    onContextChanged: (content) => {
      c.contextChanges.push(content);
      notify();
    },
    onParseError: (filePath, error) => {
      c.parseErrors.push({ filePath, error });
      notify();
    },
  };
  const waitFor = (predicate: () => boolean, timeoutMs = 2500): Promise<void> =>
    new Promise((resolve, reject) => {
      if (predicate()) return resolve();
      const timer = setTimeout(() => reject(new Error('timeout waiting for predicate')), timeoutMs);
      const check = () => {
        if (predicate()) {
          clearTimeout(timer);
          resolve();
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  return { ...c, events, waitFor };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1' as TicketId,
  projectId: PROJECT_ID,
  title: 'Fix login',
  description: 'The redirect is broken.',
  priority: 'high',
  blockedBy: [],
  columnId: 'backlog',
  createdAt: T1,
  updatedAt: T2,
  comments: [],
  runs: [],
  ...overrides,
});

const makeMilestone = (overrides: Partial<Milestone> = {}): Milestone => ({
  id: 'mile-1' as MilestoneId,
  projectId: PROJECT_ID,
  title: 'Auth overhaul',
  description: 'JWT migration.',
  status: 'active',
  createdAt: T1,
  updatedAt: T2,
  ...overrides,
});

const makePage = (overrides: Partial<Page> = {}): Page => ({
  id: 'page-1' as PageId,
  projectId: PROJECT_ID,
  parentId: null,
  title: 'Design doc',
  sortOrder: 0,
  createdAt: T1,
  updatedAt: T2,
  ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: PROJECT_ID,
  label: 'Test',
  slug: 'test',
  createdAt: T1,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dir: string;
let store: ProjectFileStore;
let collector: Collector;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pfstore-'));
  collector = makeCollector();
  store = new ProjectFileStore(dir, PROJECT_ID, collector.events);
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('open + scan', () => {
  it('creates the directory layout on open', async () => {
    await store.open();
    const { access } = await import('fs/promises');
    await access(path.join(dir, '.omni'));
    await access(path.join(dir, 'tickets'));
    await access(path.join(dir, 'milestones'));
    await access(path.join(dir, 'pages'));
  });

  it('loads pre-existing tickets, milestones, pages, context, and config', async () => {
    await mkdir(path.join(dir, '.omni'), { recursive: true });
    await mkdir(path.join(dir, 'tickets'), { recursive: true });
    await mkdir(path.join(dir, 'milestones'), { recursive: true });
    await mkdir(path.join(dir, 'pages'), { recursive: true });
    // Seed via a second store instance to avoid duplicating serialization logic.
    const seed = new ProjectFileStore(dir, PROJECT_ID, makeCollector().events);
    await seed.open();
    await seed.writeProjectConfig(makeProject({ label: 'Seeded' }));
    await seed.writeContextMd('# Seeded context\n');
    await seed.writeTicket(makeTicket());
    await seed.writeMilestone(makeMilestone());
    await seed.writePage(makePage(), 'page body\n');
    await seed.close();

    await store.open();

    expect(store.getProject()?.label).toBe('Seeded');
    expect(store.getContextMd()).toBe('# Seeded context\n');
    expect(store.listTickets()).toHaveLength(1);
    expect(store.listMilestones()).toHaveLength(1);
    expect(store.listPages()).toHaveLength(1);
    expect(store.listTickets()[0]?.title).toBe('Fix login');
  });

  it('emits parseError for an invalid ticket file', async () => {
    await mkdir(path.join(dir, 'tickets'), { recursive: true });
    await writeFile(path.join(dir, 'tickets', 'bad.md'), '---\ntitle: only\n---\n');
    await store.open();
    expect(collector.parseErrors).toHaveLength(1);
    expect(collector.parseErrors[0]?.error).toBeInstanceOf(ProjectFileError);
    expect(store.listTickets()).toHaveLength(0);
  });

  it('open is idempotent', async () => {
    await store.open();
    await store.open();
    expect(store.listTickets()).toEqual([]);
  });

  it('close is idempotent', async () => {
    await store.open();
    await store.close();
    await store.close();
  });
});

describe('writes populate the index', () => {
  beforeEach(async () => {
    await store.open();
  });

  it('writeTicket persists the file and updates listTickets', async () => {
    const t = makeTicket();
    await store.writeTicket(t);
    expect(store.listTickets()).toHaveLength(1);
    expect(store.getTicket(t.id)?.title).toBe('Fix login');
    const text = await readFile(path.join(dir, 'tickets', `${t.id}.md`), 'utf-8');
    expect(text).toContain('title: Fix login');
    expect(text).toContain('The redirect is broken.');
  });

  it('writeTicket overwrites its own projectId to match the store', async () => {
    await store.writeTicket(makeTicket({ projectId: 'wrong' as ProjectId }));
    expect(store.listTickets()[0]?.projectId).toBe(PROJECT_ID);
  });

  it('writeMilestone persists and indexes', async () => {
    await store.writeMilestone(makeMilestone({ brief: 'Detailed brief.' }));
    expect(store.listMilestones()).toHaveLength(1);
    expect(store.getMilestone('mile-1' as MilestoneId)?.brief).toBe('Detailed brief.');
  });

  it('writePage persists body alongside metadata', async () => {
    await store.writePage(makePage(), 'hello page\n');
    expect(store.listPages()).toHaveLength(1);
    expect(store.getPageBody('page-1' as PageId)).toBe('hello page\n');
  });

  it('writeProjectConfig persists to .omni/project.yml', async () => {
    await store.writeProjectConfig(makeProject());
    const text = await readFile(path.join(dir, '.omni', 'project.yml'), 'utf-8');
    expect(text).toContain('id: proj-test');
    expect(store.getProject()?.label).toBe('Test');
  });

  it('writeContextMd persists context.md verbatim', async () => {
    await store.writeContextMd('# Title\n\nBody.\n');
    const text = await readFile(path.join(dir, 'context.md'), 'utf-8');
    expect(text).toBe('# Title\n\nBody.\n');
  });
});

describe('JSONL sidecars', () => {
  beforeEach(async () => {
    await store.open();
    await store.writeTicket(makeTicket());
  });

  it('appendTicketComment grows the sidecar and the in-memory list', async () => {
    const c: TicketComment = { id: 'c1', author: 'agent', content: 'note', createdAt: T1 };
    await store.appendTicketComment('tkt-1' as TicketId, c);
    const c2: TicketComment = { id: 'c2', author: 'human', content: 'reply', createdAt: T2 };
    await store.appendTicketComment('tkt-1' as TicketId, c2);
    expect(store.getTicketComments('tkt-1' as TicketId)).toHaveLength(2);
    expect(store.getTicket('tkt-1' as TicketId)?.comments).toHaveLength(2);

    const text = await readFile(path.join(dir, 'tickets', 'tkt-1.comments.jsonl'), 'utf-8');
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('appendTicketRun grows the sidecar and the in-memory list', async () => {
    const r: TicketRun = { id: 'r1', startedAt: T1, endedAt: T2, endReason: 'completed' };
    await store.appendTicketRun('tkt-1' as TicketId, r);
    expect(store.getTicketRuns('tkt-1' as TicketId)).toEqual([r]);
    expect(store.getTicket('tkt-1' as TicketId)?.runs).toEqual([r]);
  });

  it('throws on append to unknown ticket', async () => {
    const c: TicketComment = { id: 'c1', author: 'agent', content: 'x', createdAt: T1 };
    await expect(store.appendTicketComment('missing' as TicketId, c)).rejects.toThrow(/unknown ticket/);
  });
});

describe('deletes', () => {
  beforeEach(async () => {
    await store.open();
    await store.writeTicket(makeTicket());
    await store.appendTicketComment('tkt-1' as TicketId, {
      id: 'c1',
      author: 'agent',
      content: 'x',
      createdAt: T1,
    });
    await store.writeMilestone(makeMilestone());
    await store.writePage(makePage(), 'body');
  });

  it('deleteTicket removes the ticket and its sidecars', async () => {
    await store.deleteTicket('tkt-1' as TicketId);
    expect(store.listTickets()).toHaveLength(0);
    expect(store.getTicketComments('tkt-1' as TicketId)).toEqual([]);
    const { access } = await import('fs/promises');
    await expect(access(path.join(dir, 'tickets', 'tkt-1.md'))).rejects.toThrow();
    await expect(access(path.join(dir, 'tickets', 'tkt-1.comments.jsonl'))).rejects.toThrow();
  });

  it('deleteMilestone removes the file and the index entry', async () => {
    await store.deleteMilestone('mile-1' as MilestoneId);
    expect(store.listMilestones()).toHaveLength(0);
  });

  it('deletePage removes the file and the index entry', async () => {
    await store.deletePage('page-1' as PageId);
    expect(store.listPages()).toHaveLength(0);
    expect(store.getPageBody('page-1' as PageId)).toBeNull();
  });

  it('deleting a non-existent file is a no-op', async () => {
    await store.deleteTicket('never-existed' as TicketId);
  });
});

// ---------------------------------------------------------------------------
// External change detection via real chokidar + real fs
// ---------------------------------------------------------------------------

describe('external changes', () => {
  beforeEach(async () => {
    await store.open();
  });

  it('suppresses echo events from our own writes', async () => {
    await store.writeTicket(makeTicket());
    // Give chokidar a moment to fire and be suppressed.
    await new Promise((r) => setTimeout(r, 500));
    expect(collector.tickets).toHaveLength(0);
    expect(store.getStats().echoesSuppressed).toBeGreaterThanOrEqual(1);
  });

  it('emits onTicketChanged when a ticket file is edited outside the store', async () => {
    await store.writeTicket(makeTicket());
    await new Promise((r) => setTimeout(r, 300));
    // Write a different ticket directly via fs — echo suppression should not fire.
    const externalText =
      '---\n' +
      'title: Externally edited\n' +
      'priority: low\n' +
      'column: done\n' +
      'createdAt: 2026-04-12T14:00:00Z\n' +
      'updatedAt: 2026-04-12T16:00:00Z\n' +
      '---\n\n' +
      'edited body\n';
    await writeFile(path.join(dir, 'tickets', 'tkt-1.md'), externalText);
    await collector.waitFor(() => collector.tickets.length > 0);
    expect(collector.tickets[0]?.title).toBe('Externally edited');
    expect(store.getTicket('tkt-1' as TicketId)?.title).toBe('Externally edited');
  });

  it('emits onTicketRemoved when a ticket file is unlinked externally', async () => {
    await store.writeTicket(makeTicket());
    await new Promise((r) => setTimeout(r, 300));
    await unlink(path.join(dir, 'tickets', 'tkt-1.md'));
    await collector.waitFor(() => collector.ticketsRemoved.length > 0);
    expect(collector.ticketsRemoved).toContain('tkt-1');
    expect(store.listTickets()).toHaveLength(0);
  });

  it('emits onContextChanged when context.md is edited externally', async () => {
    await store.writeContextMd('# Original\n');
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(path.join(dir, 'context.md'), '# Edited externally\n');
    await collector.waitFor(() => collector.contextChanges.length > 0);
    expect(store.getContextMd()).toBe('# Edited externally\n');
  });

  it('emits onPageChanged for an externally-added page', async () => {
    const pageText =
      '---\n' +
      'title: New page\n' +
      'sortOrder: 0\n' +
      'createdAt: 2026-04-12T14:00:00Z\n' +
      'updatedAt: 2026-04-12T14:00:00Z\n' +
      '---\n\n' +
      'fresh body\n';
    await writeFile(path.join(dir, 'pages', 'page-x.md'), pageText);
    await collector.waitFor(() => collector.pages.length > 0);
    expect(store.getPage('page-x' as PageId)?.title).toBe('New page');
    expect(store.getPageBody('page-x' as PageId)).toBe('\nfresh body\n');
  });

  it('emits parseError for an externally-added broken file', async () => {
    await writeFile(path.join(dir, 'tickets', 'broken.md'), '---\ntitle: Incomplete\n---\n');
    await collector.waitFor(() => collector.parseErrors.length > 0);
    expect(collector.parseErrors[0]?.error).toBeInstanceOf(ProjectFileError);
  });

  it('re-emits ticket change when its comments sidecar is edited externally', async () => {
    await store.writeTicket(makeTicket());
    await new Promise((r) => setTimeout(r, 300));
    const before = collector.tickets.length;
    const line = JSON.stringify({
      id: 'c-ext',
      author: 'human',
      content: 'external comment',
      createdAt: '2026-04-12T14:00:00Z',
    });
    await writeFile(path.join(dir, 'tickets', 'tkt-1.comments.jsonl'), line + '\n');
    await collector.waitFor(() => collector.tickets.length > before);
    const last = collector.tickets[collector.tickets.length - 1]!;
    expect(last.comments).toHaveLength(1);
    expect(last.comments?.[0]?.content).toBe('external comment');
  });
});
