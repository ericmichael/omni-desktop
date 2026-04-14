/**
 * PageManager — owns the lifecycle of user-authored pages (markdown + marimo
 * notebooks) for each project.
 *
 * Extracted from `ProjectManager` (Sprint A of the project-manager decomposition).
 * Mirrors the narrow-store-adapter pattern already established by `InboxManager`
 * so tests can drop in an in-memory fake without bringing up electron-store.
 *
 * Owns:
 *   - The `pages` store slice (get/set/getByProject/add/update/remove/reorder)
 *   - File I/O for page content (readContent/writeContent/watch/unwatch)
 *   - The absolute-path resolution for a page's .md / .py file on disk
 *   - The `PageWatcherManager` subscription that turns chokidar events into
 *     `page:content-changed` / `page:content-deleted` renderer notifications
 *   - Lifecycle hooks for project CRUD: `seedRootPage`, `removeAllForProject`
 *
 * Does NOT own:
 *   - Project CRUD (ProjectManager)
 *   - The authoritative `getProjectDirPath` resolver — injected via
 *     `resolveProjectDir` so this module doesn't duplicate the
 *     personal-vs-slug directory layout.
 */
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';

import { computePagesToDelete } from '@/lib/page-cascade';
import { getTemplate, type TemplateKey } from '@/lib/page-templates';
import { PageWatcherManager } from '@/lib/page-watcher';
import { MARIMO_NOTEBOOK_TEMPLATE } from '@/main/extensions/marimo';
import { writeGlassCss } from '@/main/extensions/marimo-glass';
import { ensureDirectory } from '@/main/util';
import type { IpcRendererEvents, Page, PageId, Project, ProjectId } from '@/shared/types';

// ---------------------------------------------------------------------------
// Narrow dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal store surface PageManager needs. Kept narrow so tests can fake it
 * with a plain object (same pattern as InboxManagerStore).
 */
export interface PageManagerStore {
  getPages(): Page[];
  setPages(pages: Page[]): void;
  getProjects(): Project[];
}

export type PageManagerWindowSender = <T extends keyof IpcRendererEvents>(
  channel: T,
  ...args: IpcRendererEvents[T]
) => void;

export interface PageManagerDeps {
  store: PageManagerStore;
  /** Emits `page:content-changed` / `page:content-deleted` to the renderer. */
  sendToWindow: PageManagerWindowSender;
  /**
   * Authoritative project-directory resolver. Injected because
   * ProjectManager owns the personal-vs-slug layout decision.
   */
  resolveProjectDir: (project: Project) => string;
  /** Mint a page id. Injected for deterministic tests. */
  newId?: () => string;
  /** Current wall-clock time. Injected for deterministic tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// PageManager
// ---------------------------------------------------------------------------

export class PageManager {
  private store: PageManagerStore;
  private sendToWindow: PageManagerWindowSender;
  private resolveProjectDir: (project: Project) => string;
  private newId: () => string;
  private now: () => number;
  private watcher: PageWatcherManager;

  constructor(deps: PageManagerDeps) {
    this.store = deps.store;
    this.sendToWindow = deps.sendToWindow;
    this.resolveProjectDir = deps.resolveProjectDir;
    this.newId = deps.newId ?? (() => nanoid());
    this.now = deps.now ?? (() => Date.now());
    this.watcher = new PageWatcherManager(
      {
        onExternalChange: (filePath, content) => {
          const pageId = this.pageIdForFilePath(filePath);
          if (!pageId) {
            return;
          }
          this.sendToWindow('page:content-changed', pageId, content);
        },
        onExternalDelete: (filePath) => {
          const pageId = this.pageIdForFilePath(filePath);
          if (!pageId) {
            return;
          }
          this.sendToWindow('page:content-deleted', pageId);
        },
      },
      { debug: process.env['DEBUG_PAGE_WATCHER'] === '1' || process.env['NODE_ENV'] === 'development' }
    );
  }

  // ---------- Store operations ----------

  getAll = (): Page[] => {
    return this.store.getPages();
  };

  private writeAll = (pages: Page[]): void => {
    this.store.setPages(pages);
  };

  getByProject = (projectId: ProjectId): Page[] => {
    return this.getAll().filter((p) => p.projectId === projectId);
  };

  getById = (pageId: PageId): Page | undefined => {
    return this.getAll().find((p) => p.id === pageId);
  };

  add = (input: Omit<Page, 'id' | 'createdAt' | 'updatedAt'>, template?: TemplateKey): Page => {
    const now = this.now();
    const page: Page = { ...input, id: this.newId(), createdAt: now, updatedAt: now };
    const pages = this.getAll();
    pages.push(page);
    this.writeAll(pages);

    // Seed the .md / .py file on disk. Pending-write markers keep the watcher's
    // echo-suppression from firing a spurious page:content-changed on this first write.
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (project) {
      const filePath = this.getPageFilePath(project, page);
      const initialContent = page.kind === 'notebook' ? MARIMO_NOTEBOOK_TEMPLATE : getTemplate(template);
      this.watcher.notePendingWrite(filePath, initialContent);
      void ensureDirectory(path.dirname(filePath)).then(() =>
        fs.writeFile(filePath, initialContent, 'utf-8').catch(() => {})
      );
      // Notebook pages need the glass CSS sidecar so marimo's css_file= reference
      // resolves on first open. Default to glass-off; the renderer rewrites it
      // immediately before launching the marimo webview.
      if (page.kind === 'notebook') {
        void writeGlassCss(path.dirname(filePath), false).catch(() => {});
      }
    }
    return page;
  };

  update = (id: PageId, patch: Partial<Omit<Page, 'id' | 'projectId' | 'createdAt'>>): void => {
    const pages = this.getAll();
    const index = pages.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    pages[index] = { ...pages[index]!, ...patch, updatedAt: this.now() };
    this.writeAll(pages);
  };

  remove = (id: PageId): void => {
    const pages = this.getAll();
    const target = pages.find((p) => p.id === id);
    if (!target) {
      return;
    }
    const toDelete = computePagesToDelete(pages, id);
    if (toDelete.size === 0) {
      return; // target is root or not found
    }

    // Unsubscribe BEFORE deleting the file so chokidar's unlink event doesn't
    // reach the watcher and emit a phantom page:content-deleted to any subscriber.
    const project = this.store.getProjects().find((p) => p.id === target.projectId);
    if (project) {
      for (const pageId of toDelete) {
        const page = pages.find((p) => p.id === pageId);
        if (page) {
          const filePath = this.getPageFilePath(project, page);
          this.watcher.unsubscribe(filePath);
          void fs.rm(filePath, { force: true }).catch(() => {});
        }
      }
    }

    this.writeAll(pages.filter((p) => !toDelete.has(p.id)));
  };

  reorder = (pageId: PageId, newParentId: PageId | null, newSortOrder: number): void => {
    const pages = this.getAll();
    const index = pages.findIndex((p) => p.id === pageId);
    if (index === -1) {
      return;
    }
    pages[index] = {
      ...pages[index]!,
      parentId: newParentId,
      sortOrder: newSortOrder,
      updatedAt: this.now(),
    };
    this.writeAll(pages);
  };

  // ---------- File I/O ----------

  readContent = async (pageId: PageId): Promise<string> => {
    const page = this.getById(pageId);
    if (!page) {
      return '';
    }
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (!project) {
      return '';
    }
    const filePath = this.getPageFilePath(project, page);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  };

  writeContent = async (pageId: PageId, content: string): Promise<void> => {
    const page = this.getById(pageId);
    if (!page) {
      return;
    }
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (!project) {
      return;
    }
    const filePath = this.getPageFilePath(project, page);
    await ensureDirectory(path.dirname(filePath));
    // Record the pending write BEFORE touching disk so the resulting chokidar
    // event is recognized as our own echo and suppressed.
    this.watcher.notePendingWrite(filePath, content);
    await fs.writeFile(filePath, content, 'utf-8');
  };

  /** Renderer-facing: start watching a page's file for external edits. */
  watch = async (pageId: PageId): Promise<{ content: string } | null> => {
    const page = this.getById(pageId);
    if (!page) {
      return null;
    }
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (!project) {
      return null;
    }
    const filePath = this.getPageFilePath(project, page);
    await this.watcher.subscribe(filePath);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      // File may not exist yet; subscriber will be notified if it appears.
    }
    return { content };
  };

  unwatch = (pageId: PageId): void => {
    const page = this.getById(pageId);
    if (!page) {
      return;
    }
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (!project) {
      return;
    }
    const filePath = this.getPageFilePath(project, page);
    this.watcher.unsubscribe(filePath);
  };

  /** Absolute filesystem path for a notebook page (null for non-notebook or unknown pages). */
  getNotebookFilePath = (pageId: PageId): string | null => {
    const page = this.getById(pageId);
    if (!page || page.kind !== 'notebook') {
      return null;
    }
    const project = this.store.getProjects().find((p) => p.id === page.projectId);
    if (!project) {
      return null;
    }
    return this.getPageFilePath(project, page);
  };

  // ---------- Project-lifecycle helpers (called by ProjectManager) ----------

  /** Called from ProjectManager.addProject to seed the project's root page. */
  seedRootPage = (project: Project): Page => {
    const now = this.now();
    const rootPage: Page = {
      id: this.newId(),
      projectId: project.id,
      parentId: null,
      title: project.label,
      sortOrder: 0,
      isRoot: true,
      createdAt: now,
      updatedAt: now,
    };
    const pages = this.getAll();
    pages.push(rootPage);
    this.writeAll(pages);
    return rootPage;
  };

  /** Called from ProjectManager.removeProject to cascade-delete the project's pages. */
  removeAllForProject = (projectId: ProjectId): void => {
    const remaining = this.getAll().filter((p) => p.projectId !== projectId);
    this.writeAll(remaining);
  };

  // ---------- Internal ----------

  /** Page file path resolver — root pages use <projectDir>/context.md,
   *  doc pages use <projectDir>/pages/<id>.md, notebooks use .py. */
  private getPageFilePath = (project: Project, page: Page): string => {
    const dir = this.resolveProjectDir(project);
    if (page.isRoot) {
      return path.join(dir, 'context.md');
    }
    const ext = page.kind === 'notebook' ? '.py' : '.md';
    return path.join(dir, 'pages', `${page.id}${ext}`);
  };

  /** Reverse-lookup a pageId from its on-disk file path (for watcher events). */
  private pageIdForFilePath = (filePath: string): PageId | null => {
    const pages = this.getAll();
    const projects = this.store.getProjects();
    for (const page of pages) {
      const project = projects.find((p) => p.id === page.projectId);
      if (!project) {
        continue;
      }
      if (this.getPageFilePath(project, page) === filePath) {
        return page.id;
      }
    }
    return null;
  };

  dispose = async (): Promise<void> => {
    await this.watcher.dispose();
  };
}
