import type { Page, PageId } from '@/shared/types';

/**
 * Given a flat list of pages and a target page to delete, compute the transitive
 * set of page IDs that must be removed (target + all descendants).
 *
 * Rules:
 * - If the target is not found, returns an empty set.
 * - If the target is a root page, returns an empty set — root pages cannot be deleted.
 * - Orphan pages (parentId points to a nonexistent page) are untouched.
 * - Sibling pages of the target are untouched.
 * - The relation is computed by transitive closure of `parentId`, so any depth works.
 *
 * Pure: does not mutate `pages`.
 */
export function computePagesToDelete(pages: readonly Page[], targetId: PageId): Set<PageId> {
  const target = pages.find((p) => p.id === targetId);
  if (!target || target.isRoot) return new Set();

  const toDelete = new Set<PageId>([targetId]);
  // Fixed-point expansion. Bounded by page count so always terminates.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pages) {
      if (p.parentId && toDelete.has(p.parentId) && !toDelete.has(p.id)) {
        toDelete.add(p.id);
        changed = true;
      }
    }
  }
  return toDelete;
}
