import { describe, expect, it } from 'vitest';

import { computePagesToDelete } from '@/lib/page-cascade';
import type { Page, PageId } from '@/shared/types';

/** Build a minimal Page with sensible defaults. */
function makePage(id: PageId, parentId: PageId | null, opts: { isRoot?: boolean } = {}): Page {
  return {
    id,
    projectId: 'proj-1',
    parentId,
    title: id,
    sortOrder: 0,
    isRoot: opts.isRoot ?? false,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('computePagesToDelete', () => {
  it('returns empty set when target does not exist', () => {
    const pages = [makePage('root', null, { isRoot: true }), makePage('a', 'root')];
    expect(computePagesToDelete(pages, 'missing')).toEqual(new Set());
  });

  it('returns empty set when target is the root page', () => {
    const pages = [makePage('root', null, { isRoot: true }), makePage('a', 'root')];
    expect(computePagesToDelete(pages, 'root')).toEqual(new Set());
  });

  it('deletes just the target when it is a leaf', () => {
    const pages = [makePage('root', null, { isRoot: true }), makePage('a', 'root'), makePage('b', 'root')];
    expect(computePagesToDelete(pages, 'a')).toEqual(new Set(['a']));
  });

  it('deletes target + direct children', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('a-1', 'a'),
      makePage('a-2', 'a'),
    ];
    expect(computePagesToDelete(pages, 'a')).toEqual(new Set(['a', 'a-1', 'a-2']));
  });

  it('deletes target + grandchildren (depth 3)', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('a-1', 'a'),
      makePage('a-1-1', 'a-1'),
      makePage('a-1-1-1', 'a-1-1'),
    ];
    expect(computePagesToDelete(pages, 'a')).toEqual(new Set(['a', 'a-1', 'a-1-1', 'a-1-1-1']));
  });

  it('does not touch siblings of the target', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('a-1', 'a'),
      makePage('b', 'root'),
      makePage('b-1', 'b'),
    ];
    const result = computePagesToDelete(pages, 'a');
    expect(result).toEqual(new Set(['a', 'a-1']));
    expect(result.has('b')).toBe(false);
    expect(result.has('b-1')).toBe(false);
  });

  it('does not touch the root page when deleting a mid-tree branch', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('a-1', 'a'),
    ];
    const result = computePagesToDelete(pages, 'a');
    expect(result.has('root')).toBe(false);
  });

  it('ignores orphan pages whose parentId points to a missing page', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('orphan', 'ghost' as PageId),
    ];
    const result = computePagesToDelete(pages, 'a');
    expect(result).toEqual(new Set(['a']));
    expect(result.has('orphan')).toBe(false);
  });

  it('handles wide trees (many siblings under one parent)', () => {
    const pages: Page[] = [makePage('root', null, { isRoot: true }), makePage('a', 'root')];
    for (let i = 0; i < 20; i++) {
      pages.push(makePage(`a-${i}` as PageId, 'a'));
    }
    const result = computePagesToDelete(pages, 'a');
    expect(result.size).toBe(21); // a + 20 children
    expect(result.has('a')).toBe(true);
    expect(result.has('a-0')).toBe(true);
    expect(result.has('a-19')).toBe(true);
  });

  it('does not mutate the input array', () => {
    const pages = [
      makePage('root', null, { isRoot: true }),
      makePage('a', 'root'),
      makePage('a-1', 'a'),
    ];
    const snapshot = JSON.stringify(pages);
    computePagesToDelete(pages, 'a');
    expect(JSON.stringify(pages)).toBe(snapshot);
  });

  it('handles the case where input order is reversed (children before parents)', () => {
    const pages = [
      makePage('a-1-1', 'a-1'),
      makePage('a-1', 'a'),
      makePage('a', 'root'),
      makePage('root', null, { isRoot: true }),
    ];
    expect(computePagesToDelete(pages, 'a')).toEqual(new Set(['a', 'a-1', 'a-1-1']));
  });
});
