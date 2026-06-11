import { describe, expect, it } from 'vitest';

import type { Page } from '@/shared/types';

import { getProjectRootLevelPages } from './sidebar-tree-model';

const makePage = (input: Partial<Page> & Pick<Page, 'id' | 'projectId' | 'parentId' | 'title'>): Page => ({
  icon: undefined,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...input,
});

describe('getProjectRootLevelPages', () => {
  it('includes tool-created root-level pages and UI-created root children', () => {
    const root = makePage({ id: 'pg_root', projectId: 'proj_1', parentId: null, title: 'Project Brief', isRoot: true });
    const toolPage = makePage({ id: 'pg_tool', projectId: 'proj_1', parentId: null, title: 'GA Release Brief' });
    const uiPage = makePage({ id: 'pg_ui', projectId: 'proj_1', parentId: root.id, title: 'Documentation Index' });
    const child = makePage({ id: 'pg_child', projectId: 'proj_1', parentId: toolPage.id, title: 'GA User Stories' });
    const other = makePage({ id: 'pg_other', projectId: 'proj_2', parentId: null, title: 'Other Project' });

    expect(
      getProjectRootLevelPages(
        { pg_root: root, pg_tool: toolPage, pg_ui: uiPage, pg_child: child, pg_other: other },
        'proj_1'
      )
    ).toEqual([toolPage, uiPage]);
  });
});
