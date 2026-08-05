import type { Page, PageId, ProjectId } from '@/shared/types';

export type PageListEntry = {
  page: Page;
  /** 0 for root-level pages (children of the project's root page), +1 per nesting level. */
  depth: number;
};

/**
 * Flatten a project's page hierarchy into a depth-annotated list for indented
 * rendering (Pages tab, Home Pages section). The project's root page itself is
 * excluded — it's the project Home page, surfaced separately. Children of the root
 * page (and legacy pages with `parentId === null`) are depth 0; each nesting
 * level below adds 1. Siblings sort by `sortOrder`. Pages whose parent chain
 * is missing (orphans) are tolerated and appended at depth 0 so nothing
 * silently disappears from the list.
 */
export function flattenPageTree(pages: Record<string, Page>, projectId: ProjectId): PageListEntry[] {
  const projectPages = Object.values(pages).filter((p) => p.projectId === projectId);
  const rootPage = projectPages.find((p) => p.isRoot);

  const childrenByParent = new Map<PageId | null, Page[]>();
  for (const page of projectPages) {
    if (page.isRoot) {
      continue;
    }
    const key = page.parentId ?? null;
    const list = childrenByParent.get(key) ?? [];
    list.push(page);
    childrenByParent.set(key, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  const result: PageListEntry[] = [];
  const visited = new Set<PageId>();

  const walk = (parentKey: PageId | null, depth: number): void => {
    for (const page of childrenByParent.get(parentKey) ?? []) {
      if (visited.has(page.id)) {
        continue;
      }
      visited.add(page.id);
      result.push({ page, depth });
      walk(page.id, depth + 1);
    }
  };

  // Top level: children of the root page, plus legacy null-parent pages.
  if (rootPage) {
    walk(rootPage.id, 0);
  }
  walk(null, 0);

  // Orphans: parent exists in neither the map nor the root — append flat.
  for (const page of projectPages) {
    if (!page.isRoot && !visited.has(page.id)) {
      visited.add(page.id);
      result.push({ page, depth: 0 });
      walk(page.id, 1);
    }
  }

  return result;
}
