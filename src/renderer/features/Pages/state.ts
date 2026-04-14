import { map } from 'nanostores';

import type { TemplateKey } from '@/lib/page-templates';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { Page, PageId, ProjectId } from '@/shared/types';

/**
 * All pages for the currently viewed project, keyed by page ID.
 */
export const $pages = map<Record<PageId, Page>>({});

export const pageApi = {
  fetchPages: async (projectId: ProjectId): Promise<void> => {
    const items = await emitter.invoke('page:get-items', projectId);
    // Merge: replace this project's pages, keep others untouched. This lets
    // views that span multiple projects (e.g. the global Inbox) accumulate
    // pages without clobbering each other.
    const current = $pages.get();
    const next: Record<PageId, Page> = {};
    for (const [id, page] of Object.entries(current)) {
      if (page.projectId !== projectId) {
next[id] = page;
}
    }
    for (const item of items) {
      next[item.id] = item;
    }
    $pages.set(next);
  },

  fetchAllPages: async (): Promise<void> => {
    const items = await emitter.invoke('page:get-all');
    const next: Record<PageId, Page> = {};
    for (const item of items) {
      next[item.id] = item;
    }
    $pages.set(next);
  },

  addPage: async (input: Omit<Page, 'id' | 'createdAt' | 'updatedAt'>, template?: TemplateKey): Promise<Page> => {
    const created = await emitter.invoke('page:add-item', input, template);
    $pages.setKey(created.id, created);
    return created;
  },

  updatePage: async (id: PageId, patch: Partial<Omit<Page, 'id' | 'projectId' | 'createdAt'>>): Promise<void> => {
    await emitter.invoke('page:update-item', id, patch);
    const existing = $pages.get()[id];
    if (existing) {
      $pages.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },

  removePage: async (id: PageId): Promise<void> => {
    await emitter.invoke('page:remove-item', id);
    // Remove this page and all descendants from the local map
    const current = { ...$pages.get() };
    const toDelete = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const page of Object.values(current)) {
        if (page.parentId && toDelete.has(page.parentId) && !toDelete.has(page.id)) {
          toDelete.add(page.id);
          changed = true;
        }
      }
    }
    for (const pageId of toDelete) {
      delete current[pageId];
    }
    $pages.set(current);
  },

  readContent: (pageId: PageId): Promise<string> => {
    return emitter.invoke('page:read-content', pageId);
  },

  writeContent: (pageId: PageId, content: string): Promise<void> => {
    return emitter.invoke('page:write-content', pageId, content);
  },

  reorderPage: (pageId: PageId, newParentId: PageId | null, newSortOrder: number): Promise<void> => {
    return emitter.invoke('page:reorder', pageId, newParentId, newSortOrder);
  },

  /**
   * Start watching a page file for external edits. Returns the current on-disk content
   * so callers can use this in place of `readContent` on mount.
   */
  watch: async (pageId: PageId): Promise<string> => {
    const result = await emitter.invoke('page:watch', pageId);
    return result?.content ?? '';
  },

  unwatch: (pageId: PageId): Promise<void> => {
    return emitter.invoke('page:unwatch', pageId);
  },

  /**
   * Subscribe to external-edit events for a specific page. Returns an unsubscribe function.
   * Filters events to only fire for the given pageId.
   */
  onExternalChange: (pageId: PageId, handler: (content: string) => void): (() => void) => {
    return ipc.on('page:content-changed', (id, content) => {
      if (id === pageId) {
handler(content);
}
    });
  },

  onExternalDelete: (pageId: PageId, handler: () => void): (() => void) => {
    return ipc.on('page:content-deleted', (id) => {
      if (id === pageId) {
handler();
}
    });
  },
};
