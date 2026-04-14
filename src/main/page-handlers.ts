/**
 * IPC handler registration for the pages surface (markdown + marimo notebooks).
 *
 * Extracted from `createProjectManager` (Sprint C4). The notebook handlers
 * need to resolve the project's working directory, so the caller injects a
 * `getProjectDir(projectId)` callback rather than this module reaching back
 * into ProjectManager.
 */
import path from 'path';

import { writeMarimoAiConfig } from '@/main/extensions/marimo-config';
import { ensureNotebookCssReference, writeGlassCss } from '@/main/extensions/marimo-glass';
import type { PageManager } from '@/main/page-manager';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ProjectId } from '@/shared/types';

export function registerPageHandlers(
  ipc: IIpcListener,
  pageManager: PageManager,
  getProjectDir: (projectId: ProjectId) => string | null
): string[] {
  ipc.handle('page:get-items', (_, projectId) => pageManager.getByProject(projectId));
  ipc.handle('page:get-all', () => pageManager.getAll());
  ipc.handle('page:add-item', (_, item, template) => pageManager.add(item, template));
  ipc.handle('page:update-item', (_, id, patch) => pageManager.update(id, patch));
  ipc.handle('page:remove-item', (_, id) => pageManager.remove(id));
  ipc.handle('page:read-content', (_, pageId) => pageManager.readContent(pageId));
  ipc.handle('page:write-content', (_, pageId, content) => pageManager.writeContent(pageId, content));
  ipc.handle('page:reorder', (_, pageId, newParentId, newSortOrder) =>
    pageManager.reorder(pageId, newParentId, newSortOrder)
  );
  ipc.handle('page:watch', (_, pageId) => pageManager.watch(pageId));
  ipc.handle('page:unwatch', (_, pageId) => pageManager.unwatch(pageId));
  ipc.handle('page:get-notebook-paths', (_, pageId) => {
    const filePath = pageManager.getNotebookFilePath(pageId);
    if (!filePath) {
      return null;
    }
    const page = pageManager.getById(pageId);
    if (!page) {
      return null;
    }
    const projectDir = getProjectDir(page.projectId);
    if (!projectDir) {
      return null;
    }
    return { filePath, projectDir };
  });
  ipc.handle('page:prepare-notebook', async (_, pageId, glassEnabled) => {
    const filePath = pageManager.getNotebookFilePath(pageId);
    if (!filePath) {
      return;
    }
    const pagesDir = path.dirname(filePath);
    await writeGlassCss(pagesDir, glassEnabled);
    await ensureNotebookCssReference(filePath);
    // Wire the launcher's default model into marimo via .marimo.toml in the
    // project directory (marimo searches up from cwd for it). Only writes
    // when a default model with an api key is configured; refuses to
    // clobber any pre-existing user-authored .marimo.toml.
    const page = pageManager.getById(pageId);
    if (page) {
      const projectDir = getProjectDir(page.projectId);
      if (projectDir) {
        await writeMarimoAiConfig(projectDir);
      }
    }
  });
  ipc.handle('page:set-notebook-glass', async (_, projectDir, enabled) => {
    // The renderer passes the project's working directory; notebook files
    // (and the glass CSS) live in `<projectDir>/pages/`.
    const pagesDir = path.join(projectDir, 'pages');
    await writeGlassCss(pagesDir, enabled);
  });

  return [
    'page:get-items',
    'page:get-all',
    'page:add-item',
    'page:update-item',
    'page:remove-item',
    'page:read-content',
    'page:write-content',
    'page:reorder',
    'page:watch',
    'page:unwatch',
    'page:get-notebook-paths',
    'page:prepare-notebook',
    'page:set-notebook-glass',
  ];
}
