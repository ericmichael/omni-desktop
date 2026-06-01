import { describe, expect, it, vi } from 'vitest';

import { atom } from 'nanostores';

import type { Page, StoreData } from '@/shared/types';

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: vi.fn() },
  ipc: { on: vi.fn() },
}));

vi.mock('@/renderer/services/store', () => ({
  persistedStoreApi: { $atom: atom({ pages: [] } as unknown as StoreData) },
}));

import { pagesRecordFromStorePages } from './state';

const makePage = (id: string, projectId: string, parentId: string | null, title: string): Page => ({
  id,
  projectId,
  parentId,
  title,
  icon: undefined,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

describe('pages state', () => {
  it('maps store snapshot pages by id', () => {
    const page = makePage('pg_1', 'proj_1', null, 'Documentation Index');

    expect(pagesRecordFromStorePages([page])).toEqual({ pg_1: page });
  });

  it('preserves updated titles, icons, and parent relationships from snapshots', () => {
    const original = makePage('pg_1', 'proj_1', null, 'Documentation Index');
    const updated = { ...original, title: 'GA User Stories', icon: '🧩', updatedAt: 2 };

    expect(pagesRecordFromStorePages([updated])).toEqual({ pg_1: updated });
  });
});
