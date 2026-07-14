import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoreData } from '@/shared/types';

const invoke = vi.fn((channel: string) => {
  if (channel === 'project:get-tasks' || channel === 'project:get-tickets' || channel === 'milestone:get-items') {
    return Promise.resolve([]);
  }
  if (channel === 'page:get-items') {
    return Promise.resolve([]);
  }
  if (channel === 'project:get-pipeline') {
    return Promise.resolve({ columns: [] });
  }
  return Promise.resolve();
});

let store: Partial<StoreData>;

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke },
  ipc: { on: vi.fn(() => () => {}) },
}));

vi.mock('@/renderer/services/store', () => ({
  persistedStoreApi: {
    $atom: {
      get: () => store,
      subscribe: (cb: (value: unknown) => void) => {
        cb(store);
        return () => {};
      },
    },
    setKey: vi.fn(),
    getKey: (key: keyof StoreData) => store[key],
  },
}));

vi.mock('@/renderer/constants', () => ({
  STATUS_POLL_INTERVAL_MS: 999999999,
}));

store = { tickets: [], pages: [], projects: [], codeTabs: [] };

const { $pages } = await import('@/renderer/features/Pages/state');
const { $activeMilestoneId, $ticketsHistory, $ticketsView, ticketApi, viewProjectId } = await import('./state');

describe('tickets navigation', () => {
  beforeEach(() => {
    invoke.mockClear();
    $ticketsView.set({ type: 'all' });
    $ticketsHistory.set([]);
    $activeMilestoneId.set('all');
  });

  it('goToProject defaults to the home tab', () => {
    ticketApi.goToProject('p1');
    expect($ticketsView.get()).toEqual({ type: 'project', projectId: 'p1', tab: 'home' });
  });

  it('goToProject accepts an explicit tab', () => {
    ticketApi.goToProject('p1', 'settings');
    expect($ticketsView.get()).toEqual({ type: 'project', projectId: 'p1', tab: 'settings' });
  });

  it('goToBoard is sugar for the board tab and resets the milestone filter', () => {
    $activeMilestoneId.set('m1');
    ticketApi.goToBoard('p1');
    expect($ticketsView.get()).toEqual({ type: 'project', projectId: 'p1', tab: 'board' });
    expect($activeMilestoneId.get()).toBe('all');
  });

  it('goBackToPrevious replays the previous project view including its tab', () => {
    ticketApi.goToProject('p1', 'board');
    ticketApi.goToPage('page-1', 'p1');
    ticketApi.goBackToPrevious();
    expect($ticketsView.get()).toEqual({ type: 'project', projectId: 'p1', tab: 'board' });
  });

  it('goBackToPrevious returns to the previous ticket (real history stack)', () => {
    ticketApi.goToTicket('t1');
    ticketApi.goToTicket('t2');
    ticketApi.goBackToPrevious('p1');
    expect($ticketsView.get()).toEqual({ type: 'ticket', ticketId: 't1' });
  });

  it('goBackToPrevious falls back to the project when the stack is empty', () => {
    $ticketsHistory.set([]);
    ticketApi.goBackToPrevious('p1');
    expect($ticketsView.get()).toEqual({ type: 'project', projectId: 'p1', tab: 'home' });
  });

  it('goBackToPrevious falls back to all work with no fallback project', () => {
    $ticketsHistory.set([]);
    ticketApi.goBackToPrevious();
    expect($ticketsView.get()).toEqual({ type: 'all' });
  });

  it('viewProjectId resolves project-scoped views and null for global ones', () => {
    expect(viewProjectId({ type: 'project', projectId: 'p1', tab: 'home' })).toBe('p1');
    expect(viewProjectId({ type: 'page', pageId: 'pg', projectId: 'p2' })).toBe('p2');
    expect(viewProjectId({ type: 'milestone', milestoneId: 'm', projectId: 'p3' })).toBe('p3');
    expect(viewProjectId({ type: 'all' })).toBeNull();
    expect(viewProjectId({ type: 'ticket', ticketId: 't1' })).toBeNull();
  });
});

describe('renameProject', () => {
  beforeEach(() => {
    invoke.mockClear();
    $pages.set({});
  });

  it('updates the project label and syncs the root page title', async () => {
    $pages.set({
      root: {
        id: 'root',
        projectId: 'p1',
        parentId: null,
        title: 'Old name',
        sortOrder: 0,
        isRoot: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await ticketApi.renameProject('p1', '  New name  ');
    expect(invoke).toHaveBeenCalledWith('project:update-project', 'p1', { label: 'New name' });
    expect(invoke).toHaveBeenCalledWith('page:update-item', 'root', { title: 'New name' });
  });

  it('skips the page write when the root title already matches', async () => {
    $pages.set({
      root: {
        id: 'root',
        projectId: 'p1',
        parentId: null,
        title: 'Same',
        sortOrder: 0,
        isRoot: true,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await ticketApi.renameProject('p1', 'Same');
    expect(invoke).toHaveBeenCalledWith('project:update-project', 'p1', { label: 'Same' });
    expect(invoke).not.toHaveBeenCalledWith('page:update-item', 'root', expect.anything());
  });

  it('ignores empty names', async () => {
    await ticketApi.renameProject('p1', '   ');
    expect(invoke).not.toHaveBeenCalled();
  });
});
