/**
 * IPC handler registration for the pages surface (markdown + marimo notebooks).
 *
 * Takes `resolve(event)` callbacks (see registerMilestoneHandlers) so the same
 * registration serves the single-manager Electron app and the per-tenant
 * server. The notebook handlers also need the project's working directory, so
 * the caller injects a tenant-aware `getProjectDir(event, projectId)`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';

import { writeMarimoAiConfig } from '@/main/extensions/marimo-config';
import { ensureNotebookCssReference, writeGlassCss } from '@/main/extensions/marimo-glass';
import type { PageManager } from '@/main/page-manager';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ProjectId } from '@/shared/types';

export function registerPageHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => PageManager,
  getProjectDir: (event: unknown, projectId: ProjectId) => string | null
): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (m: PageManager, event: unknown, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), event, ...args));
    channels.push(ch);
  };

  h('page:get-items', (m, _e, projectId) => m.getByProject(projectId));
  h('page:get-all', (m) => m.getAll());
  h('page:add-item', (m, _e, item, template) => m.add(item, template));
  h('page:update-item', (m, _e, id, patch) => m.update(id, patch));
  h('page:remove-item', (m, _e, id) => m.remove(id));
  h('page:read-content', (m, _e, pageId) => m.readContent(pageId));
  h('page:write-content', (m, _e, pageId, content) => m.writeContent(pageId, content));
  h('page:reorder', (m, _e, pageId, newParentId, newSortOrder) => m.reorder(pageId, newParentId, newSortOrder));
  h('page:watch', (m, _e, pageId) => m.watch(pageId));
  h('page:unwatch', (m, _e, pageId) => m.unwatch(pageId));
  h('page:get-notebook-paths', (m, event, pageId) => {
    const filePath = m.getNotebookFilePath(pageId);
    if (!filePath) {
      return null;
    }
    const page = m.getById(pageId);
    if (!page) {
      return null;
    }
    const projectDir = getProjectDir(event, page.projectId);
    if (!projectDir) {
      return null;
    }
    return { filePath, projectDir };
  });
  h('page:prepare-notebook', async (m, event, pageId, glassEnabled) => {
    const filePath = m.getNotebookFilePath(pageId);
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
    const page = m.getById(pageId);
    if (page) {
      const projectDir = getProjectDir(event, page.projectId);
      if (projectDir) {
        await writeMarimoAiConfig(projectDir);
      }
    }
  });
  h('page:set-notebook-glass', async (_m, _e, projectDir, enabled) => {
    // The renderer passes the project's working directory; notebook files
    // (and the glass CSS) live in `<projectDir>/pages/`.
    const pagesDir = path.join(projectDir, 'pages');
    await writeGlassCss(pagesDir, enabled);
  });

  return channels;
}
