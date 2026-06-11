import type { Page, ProjectId } from '@/shared/types';

export function getProjectRootLevelPages(pages: Record<string, Page>, projectId: ProjectId): Page[] {
  const rootPage = Object.values(pages).find((page) => page.projectId === projectId && page.isRoot);
  const rootParentId = rootPage?.id;
  return Object.values(pages)
    .filter(
      (page) =>
        page.projectId === projectId && !page.isRoot && (page.parentId === null || page.parentId === rootParentId)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
