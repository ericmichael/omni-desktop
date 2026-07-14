import { describe, expect, it } from 'vitest';

import { flattenPageTree } from '@/lib/page-list';
import type { Page } from '@/shared/types';

const page = (patch: Partial<Page> & { id: string }): Page => ({
  projectId: 'p1',
  parentId: null,
  title: patch.id,
  sortOrder: 0,
  isRoot: false,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const toMap = (pages: Page[]): Record<string, Page> => Object.fromEntries(pages.map((p) => [p.id, p]));

describe('flattenPageTree', () => {
  it('excludes the root page and orders siblings by sortOrder', () => {
    const pages = toMap([
      page({ id: 'root', isRoot: true }),
      page({ id: 'b', parentId: 'root', sortOrder: 2 }),
      page({ id: 'a', parentId: 'root', sortOrder: 1 }),
    ]);
    const entries = flattenPageTree(pages, 'p1');
    expect(entries.map((e) => e.page.id)).toEqual(['a', 'b']);
    expect(entries.every((e) => e.depth === 0)).toBe(true);
  });

  it('nests children directly under their parent with increasing depth', () => {
    const pages = toMap([
      page({ id: 'root', isRoot: true }),
      page({ id: 'a', parentId: 'root', sortOrder: 1 }),
      page({ id: 'a1', parentId: 'a', sortOrder: 1 }),
      page({ id: 'a1x', parentId: 'a1', sortOrder: 1 }),
      page({ id: 'b', parentId: 'root', sortOrder: 2 }),
    ]);
    const entries = flattenPageTree(pages, 'p1');
    expect(entries.map((e) => [e.page.id, e.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['b', 0],
    ]);
  });

  it('treats legacy null-parent pages as top-level', () => {
    const pages = toMap([
      page({ id: 'root', isRoot: true }),
      page({ id: 'child', parentId: 'root', sortOrder: 1 }),
      page({ id: 'legacy', parentId: null, sortOrder: 5 }),
    ]);
    const entries = flattenPageTree(pages, 'p1');
    expect(entries.map((e) => e.page.id)).toEqual(['child', 'legacy']);
    expect(entries[1]!.depth).toBe(0);
  });

  it('appends orphaned pages (missing parent) at depth 0 instead of dropping them', () => {
    const pages = toMap([
      page({ id: 'root', isRoot: true }),
      page({ id: 'ok', parentId: 'root', sortOrder: 1 }),
      page({ id: 'orphan', parentId: 'gone', sortOrder: 1 }),
      page({ id: 'orphan-child', parentId: 'orphan', sortOrder: 1 }),
    ]);
    const entries = flattenPageTree(pages, 'p1');
    expect(entries.map((e) => [e.page.id, e.depth])).toEqual([
      ['ok', 0],
      ['orphan', 0],
      ['orphan-child', 1],
    ]);
  });

  it('ignores pages from other projects', () => {
    const pages = toMap([
      page({ id: 'root', isRoot: true }),
      page({ id: 'mine', parentId: 'root' }),
      page({ id: 'other', projectId: 'p2', parentId: null }),
    ]);
    expect(flattenPageTree(pages, 'p1').map((e) => e.page.id)).toEqual(['mine']);
  });

  it('handles a project with no root page', () => {
    const pages = toMap([page({ id: 'a', parentId: null, sortOrder: 1 })]);
    expect(flattenPageTree(pages, 'p1').map((e) => e.page.id)).toEqual(['a']);
  });
});
