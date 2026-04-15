/**
 * Tests for PageManager — page CRUD, path resolution, file I/O,
 * seed/cascade lifecycle, and reorder.
 *
 * Uses an in-memory store fake and a real tmpdir for file I/O tests.
 * The PageWatcherManager is a real instance (backed by chokidar) but
 * we test mostly the store-level logic; the watcher is covered in
 * page-watcher.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageManager, type PageManagerStore, type PageManagerWindowSender } from '@/main/page-manager';
import type { Page, Project } from '@/shared/types';

// ---------------------------------------------------------------------------
// Mocks — suppress file watcher side effects
// ---------------------------------------------------------------------------

vi.mock('@/main/util', () => ({
  ensureDirectory: vi.fn(async (dir: string) => {
    mkdirSync(dir, { recursive: true });
  }),
}));

vi.mock('@/main/extensions/marimo-glass', () => ({
  writeGlassCss: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectDir: string;
let idCounter: number;
let clock: number;

function makeStore(initial?: { pages?: Page[]; projects?: Project[] }): PageManagerStore & { pages: Page[] } {
  const store = {
    pages: initial?.pages ?? [],
    projects: initial?.projects ?? [],
    getPages() {
      return store.pages;
    },
    setPages(items: Page[]) {
      store.pages = items;
    },
    getProjects() {
      return store.projects as Project[];
    },
  };
  return store;
}

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: 'proj-1',
    label: 'My Project',
    slug: 'my-project',
    createdAt: 100,
    ...overrides,
  } as Project;
}

const noopSend: PageManagerWindowSender = () => {};

function makeMgr(opts?: { pages?: Page[]; projects?: Project[] }) {
  idCounter = 0;
  clock = 1000;
  const project = opts?.projects?.[0] ?? makeProject();
  const store = makeStore({
    pages: opts?.pages ?? [],
    projects: opts?.projects ?? [project],
  });
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  const send: PageManagerWindowSender = ((channel: string, ...args: unknown[]) => {
    sendCalls.push({ channel, args });
  }) as PageManagerWindowSender;
  const mgr = new PageManager({
    store,
    sendToWindow: send,
    resolveProjectDir: () => projectDir,
    newId: () => `page-${++idCounter}`,
    now: () => clock,
  });
  return { mgr, store, sendCalls };
}

// ---------------------------------------------------------------------------
// Setup/Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pages-'));
});

afterEach(async () => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PageManager', () => {
  describe('CRUD', () => {
    it('starts empty', () => {
      const { mgr } = makeMgr();
      expect(mgr.getAll()).toEqual([]);
    });

    it('adds a doc page with generated id and timestamps', () => {
      const { mgr } = makeMgr();
      const page = mgr.add({ projectId: 'proj-1', parentId: null, title: 'Notes', sortOrder: 0 });

      expect(page.id).toBe('page-1');
      expect(page.projectId).toBe('proj-1');
      expect(page.title).toBe('Notes');
      expect(page.createdAt).toBe(1000);
      expect(page.updatedAt).toBe(1000);
    });

    it('persists added page to store', () => {
      const { mgr, store } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'Notes', sortOrder: 0 });
      expect(store.pages).toHaveLength(1);
    });

    it('getById returns the page', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'Notes', sortOrder: 0 });
      expect(mgr.getById('page-1')?.title).toBe('Notes');
    });

    it('getById returns undefined for unknown id', () => {
      const { mgr } = makeMgr();
      expect(mgr.getById('nonexistent')).toBeUndefined();
    });

    it('getByProject filters by projectId', () => {
      const proj2 = makeProject({ id: 'proj-2', label: 'Other', slug: 'other' });
      const { mgr } = makeMgr({ projects: [makeProject(), proj2] });
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'A', sortOrder: 0 });
      mgr.add({ projectId: 'proj-2', parentId: null, title: 'B', sortOrder: 0 });

      expect(mgr.getByProject('proj-1')).toHaveLength(1);
      expect(mgr.getByProject('proj-1')[0]!.title).toBe('A');
    });

    it('update modifies fields and stamps updatedAt', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'Draft', sortOrder: 0 });

      clock = 2000;
      mgr.update('page-1', { title: 'Final' });

      const page = mgr.getById('page-1')!;
      expect(page.title).toBe('Final');
      expect(page.updatedAt).toBe(2000);
      expect(page.createdAt).toBe(1000); // unchanged
    });

    it('update is a no-op for unknown id', () => {
      const { mgr, store } = makeMgr();
      mgr.update('nonexistent', { title: 'Nope' });
      expect(store.pages).toHaveLength(0);
    });

    it('remove deletes the page', () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      mgr.add({ projectId: 'proj-1', parentId: root.id, title: 'Child', sortOrder: 0 });

      // Can delete non-root child
      mgr.remove('page-2');
      // Root + no children left
      expect(mgr.getAll()).toHaveLength(1);
    });

    it('remove is a no-op for unknown id', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'Keep', sortOrder: 0 });
      mgr.remove('nonexistent');
      expect(mgr.getAll()).toHaveLength(1);
    });
  });

  describe('reorder', () => {
    it('changes parentId and sortOrder', () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'A', sortOrder: 0 });
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'B', sortOrder: 1 });

      clock = 3000;
      mgr.reorder('page-1', 'page-2', 5);

      const page = mgr.getById('page-1')!;
      expect(page.parentId).toBe('page-2');
      expect(page.sortOrder).toBe(5);
      expect(page.updatedAt).toBe(3000);
    });

    it('is a no-op for unknown pageId', () => {
      const { mgr, store } = makeMgr();
      mgr.reorder('nonexistent', null, 0);
      expect(store.pages).toHaveLength(0);
    });
  });

  describe('seedRootPage', () => {
    it('creates a root page with isRoot=true', () => {
      const { mgr } = makeMgr();
      const project = makeProject();
      const root = mgr.seedRootPage(project);

      expect(root.isRoot).toBe(true);
      expect(root.parentId).toBeNull();
      expect(root.title).toBe(project.label);
      expect(root.sortOrder).toBe(0);
      expect(root.projectId).toBe(project.id);
    });

    it('persists the root page to store', () => {
      const { mgr, store } = makeMgr();
      mgr.seedRootPage(makeProject());
      expect(store.pages).toHaveLength(1);
      expect(store.pages[0]!.isRoot).toBe(true);
    });
  });

  describe('removeAllForProject', () => {
    it('removes all pages for a project', () => {
      const proj2 = makeProject({ id: 'proj-2', label: 'Other', slug: 'other' });
      const { mgr, store } = makeMgr({ projects: [makeProject(), proj2] });
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'A', sortOrder: 0 });
      mgr.add({ projectId: 'proj-2', parentId: null, title: 'B', sortOrder: 0 });
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'C', sortOrder: 1 });

      mgr.removeAllForProject('proj-1');

      expect(store.pages).toHaveLength(1);
      expect(store.pages[0]!.projectId).toBe('proj-2');
    });
  });

  describe('file I/O', () => {
    it('readContent returns empty string for unknown page', async () => {
      const { mgr } = makeMgr();
      expect(await mgr.readContent('nonexistent' as string)).toBe('');
    });

    it('writeContent and readContent round-trip for a doc page', async () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());

      await mgr.writeContent(root.id, '# Hello World');
      const content = await mgr.readContent(root.id);
      expect(content).toBe('# Hello World');
    });

    it('readContent returns empty string when file does not exist', async () => {
      const { mgr } = makeMgr();
      mgr.add({ projectId: 'proj-1', parentId: null, title: 'Ghost', sortOrder: 0 });

      // Don't write anything — file doesn't exist
      const content = await mgr.readContent('page-1');
      expect(content).toBe('');
    });

    it('root page content is stored as context.md', async () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());

      await mgr.writeContent(root.id, '# Context');
      const onDisk = readFileSync(join(projectDir, 'context.md'), 'utf-8');
      expect(onDisk).toBe('# Context');
    });

    it('non-root doc pages are stored under pages/<id>.md', async () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      const child = mgr.add({ projectId: 'proj-1', parentId: root.id, title: 'Child', sortOrder: 0 });

      await mgr.writeContent(child.id, 'child content');
      const onDisk = readFileSync(join(projectDir, 'pages', `${child.id}.md`), 'utf-8');
      expect(onDisk).toBe('child content');
    });

    it('notebook pages are stored as .py files', async () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      const nb = mgr.add({
        projectId: 'proj-1',
        parentId: root.id,
        title: 'Notebook',
        sortOrder: 0,
        kind: 'notebook',
      });

      // add() seeds the file with MARIMO_NOTEBOOK_TEMPLATE (fire-and-forget).
      // Wait for it to land, then overwrite.
      await new Promise((r) => setTimeout(r, 50));

      await mgr.writeContent(nb.id, '# marimo code');
      const onDisk = readFileSync(join(projectDir, 'pages', `${nb.id}.py`), 'utf-8');
      expect(onDisk).toBe('# marimo code');
    });
  });

  describe('getNotebookFilePath', () => {
    it('returns path for notebook pages', () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      const nb = mgr.add({
        projectId: 'proj-1',
        parentId: root.id,
        title: 'NB',
        sortOrder: 0,
        kind: 'notebook',
      });

      const p = mgr.getNotebookFilePath(nb.id);
      expect(p).toBe(join(projectDir, 'pages', `${nb.id}.py`));
    });

    it('returns null for doc pages', () => {
      const { mgr } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      const doc = mgr.add({ projectId: 'proj-1', parentId: root.id, title: 'Doc', sortOrder: 0 });

      expect(mgr.getNotebookFilePath(doc.id)).toBeNull();
    });

    it('returns null for unknown pages', () => {
      const { mgr } = makeMgr();
      expect(mgr.getNotebookFilePath('nonexistent' as string)).toBeNull();
    });
  });

  describe('cascade delete', () => {
    it('remove deletes children recursively', () => {
      const { mgr, store } = makeMgr();
      const root = mgr.seedRootPage(makeProject());
      const parent = mgr.add({ projectId: 'proj-1', parentId: root.id, title: 'Parent', sortOrder: 0 });
      mgr.add({ projectId: 'proj-1', parentId: parent.id, title: 'Child', sortOrder: 0 });
      mgr.add({ projectId: 'proj-1', parentId: parent.id, title: 'Child 2', sortOrder: 1 });

      // Deleting parent should cascade to its children
      mgr.remove(parent.id);

      // Only root should remain
      expect(store.pages).toHaveLength(1);
      expect(store.pages[0]!.isRoot).toBe(true);
    });
  });
});
