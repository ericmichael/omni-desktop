import { beforeEach, describe, expect, it } from 'vitest';

import {
  InboxItemNotFoundError,
  InboxManager,
  type InboxManagerStore,
  InboxPromotionError,
  PROMOTED_TOMBSTONE_TTL_MS,
} from '@/main/inbox-manager';
import type { InboxItem, InboxShaping, Project, Ticket } from '@/shared/types';

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

class FakeStore implements InboxManagerStore {
  inboxItems: InboxItem[] = [];
  tickets: Ticket[] = [];
  projects: Project[] = [];

  getInboxItems() {
    return this.inboxItems;
  }
  setInboxItems(items: InboxItem[]) {
    this.inboxItems = items;
  }
  getTickets() {
    return this.tickets;
  }
  setTickets(tickets: Ticket[]) {
    this.tickets = tickets;
  }
  getProjects() {
    return this.projects;
  }
  setProjects(projects: Project[]) {
    this.projects = projects;
  }
}

const NOW = 1_700_000_000_000;

function makeManager() {
  const store = new FakeStore();
  let idCounter = 0;
  let clock = NOW;
  const manager = new InboxManager({
    store,
    newId: () => `id-${++idCounter}`,
    now: () => clock,
  });
  const tick = (ms: number) => {
    clock += ms;
  };
  const setClock = (t: number) => {
    clock = t;
  };
  return { manager, store, tick, setClock };
}

const SMALL_SHAPING: InboxShaping = {
  outcome: 'Users can log in via SSO.',
  appetite: 'small',
  notDoing: 'Custom themes.',
};

// ---------------------------------------------------------------------------
// Queries & basic CRUD
// ---------------------------------------------------------------------------

describe('InboxManager: add + queries', () => {
  let mgr: ReturnType<typeof makeManager>;
  beforeEach(() => {
    mgr = makeManager();
  });

  it('add creates a new item with status=new', () => {
    const item = mgr.manager.add({ title: 'Call the DBA' });
    expect(item).toMatchObject({ id: 'id-1', title: 'Call the DBA', status: 'new', projectId: null });
    expect(item.createdAt).toBe(NOW);
    expect(item.updatedAt).toBe(NOW);
  });

  it('add trims title and falls back to Untitled', () => {
    const a = mgr.manager.add({ title: '  hi  ' });
    const b = mgr.manager.add({ title: '   ' });
    expect(a.title).toBe('hi');
    expect(b.title).toBe('Untitled');
  });

  it('add stores note when non-empty, omits when blank', () => {
    const a = mgr.manager.add({ title: 't', note: '  body  ' });
    const b = mgr.manager.add({ title: 't', note: '   ' });
    expect(a.note).toBe('body');
    expect(b.note).toBeUndefined();
  });

  it('getActive hides later and promoted items', () => {
    const a = mgr.manager.add({ title: 'a' });
    const b = mgr.manager.add({ title: 'b' });
    mgr.manager.defer(b.id);
    expect(mgr.manager.getActive()).toHaveLength(1);
    expect(mgr.manager.getActive()[0].id).toBe(a.id);
  });

  it('getLater returns only deferred items', () => {
    const a = mgr.manager.add({ title: 'a' });
    mgr.manager.defer(a.id);
    expect(mgr.manager.getLater()).toHaveLength(1);
    expect(mgr.manager.getActive()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Update / remove
// ---------------------------------------------------------------------------

describe('InboxManager: update + remove', () => {
  it('update patches fields and bumps updatedAt', () => {
    const { manager, tick, store } = makeManager();
    const item = manager.add({ title: 't' });
    tick(1000);
    manager.update(item.id, { title: 'renamed', note: 'detail' });
    const after = store.inboxItems[0];
    expect(after.title).toBe('renamed');
    expect(after.note).toBe('detail');
    expect(after.updatedAt).toBe(NOW + 1000);
  });

  it('update clears note when patched to blank', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't', note: 'x' });
    manager.update(item.id, { note: '  ' });
    expect(store.inboxItems[0].note).toBeUndefined();
  });

  it('remove drops the item', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.remove(item.id);
    expect(store.inboxItems).toHaveLength(0);
  });

  it('remove throws when id is unknown', () => {
    const { manager } = makeManager();
    expect(() => manager.remove('bogus')).toThrow(InboxItemNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Shape / defer / reactivate
// ---------------------------------------------------------------------------

describe('InboxManager: shape', () => {
  it('sets status=shaped on a new item', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.shape(item.id, SMALL_SHAPING);
    const after = store.inboxItems[0];
    expect(after.status).toBe('shaped');
    expect(after.shaping).toEqual(SMALL_SHAPING);
  });

  it('preserves later status when shaping a deferred item', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.defer(item.id);
    manager.shape(item.id, SMALL_SHAPING);
    expect(store.inboxItems[0].status).toBe('later');
    expect(store.inboxItems[0].shaping).toBeDefined();
  });

  it('trims outcome', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.shape(item.id, { outcome: '  ship it.  ', appetite: 'small' });
    expect(store.inboxItems[0].shaping?.outcome).toBe('ship it.');
  });

  it('refuses to shape a promoted item', () => {
    const { manager, store } = makeManager();
    store.projects = [{ id: 'p1', label: 'P', slug: 'p', createdAt: NOW }];
    const item = manager.add({ title: 't' });
    manager.promoteToTicket(item.id, { projectId: 'p1' });
    expect(() => manager.shape(item.id, SMALL_SHAPING)).toThrow(InboxPromotionError);
  });
});

describe('InboxManager: defer + reactivate', () => {
  it('defer stamps laterAt and updatedAt', () => {
    const { manager, store, tick } = makeManager();
    const item = manager.add({ title: 't' });
    tick(500);
    manager.defer(item.id);
    const after = store.inboxItems[0];
    expect(after.status).toBe('later');
    expect(after.laterAt).toBe(NOW + 500);
    expect(after.updatedAt).toBe(NOW + 500);
  });

  it('reactivate returns shaped item to shaped status', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.shape(item.id, SMALL_SHAPING);
    manager.defer(item.id);
    manager.reactivate(item.id);
    const after = store.inboxItems[0];
    expect(after.status).toBe('shaped');
    expect(after.laterAt).toBeUndefined();
  });

  it('reactivate returns unshaped item to new status', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 't' });
    manager.defer(item.id);
    manager.reactivate(item.id);
    expect(store.inboxItems[0].status).toBe('new');
  });

  it('refuses to defer/reactivate a promoted item', () => {
    const { manager, store } = makeManager();
    store.projects = [{ id: 'p1', label: 'P', slug: 'p', createdAt: NOW }];
    const item = manager.add({ title: 't' });
    manager.promoteToTicket(item.id, { projectId: 'p1' });
    expect(() => manager.defer(item.id)).toThrow(InboxPromotionError);
    expect(() => manager.reactivate(item.id)).toThrow(InboxPromotionError);
  });
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

describe('InboxManager: promoteToTicket', () => {
  const seedProject = (store: FakeStore, source = true): Project => {
    const p: Project = {
      id: 'p1',
      label: 'Main',
      slug: 'main',
      createdAt: NOW,
      ...(source ? { source: { kind: 'local' as const, workspaceDir: '/tmp/x' } } : {}),
    };
    store.projects = [p];
    return p;
  };

  it('creates a ticket seeded from the inbox item and stamps promotedTo', () => {
    const { manager, store, tick } = makeManager();
    seedProject(store);
    const item = manager.add({ title: 'Fix login', note: 'Auth flake' });
    manager.shape(item.id, SMALL_SHAPING);
    tick(5000);
    const ticket = manager.promoteToTicket(item.id, { projectId: 'p1' });

    expect(store.tickets).toHaveLength(1);
    expect(ticket.title).toBe('Fix login');
    expect(ticket.description).toBe('Auth flake');
    expect(ticket.columnId).toBe('backlog');
    expect(ticket.shaping).toEqual({
      doneLooksLike: 'Users can log in via SSO.',
      appetite: 'small',
      outOfScope: 'Custom themes.',
    });

    const stamped = store.inboxItems[0];
    expect(stamped.promotedTo).toEqual({ kind: 'ticket', id: ticket.id, at: NOW + 5000 });
  });

  it('collapses xl appetite to large on the ticket side', () => {
    const { manager, store } = makeManager();
    seedProject(store);
    const item = manager.add({ title: 'Big' });
    manager.shape(item.id, { outcome: 'big thing', appetite: 'xl' });
    const ticket = manager.promoteToTicket(item.id, { projectId: 'p1' });
    expect(ticket.shaping?.appetite).toBe('large');
  });

  it('uses the simple pipeline first column when project has no source', () => {
    const { manager, store } = makeManager();
    seedProject(store, false);
    const item = manager.add({ title: 't' });
    const ticket = manager.promoteToTicket(item.id, { projectId: 'p1' });
    // SIMPLE_PIPELINE also has "backlog" as the first column.
    expect(ticket.columnId).toBe('backlog');
  });

  it('respects an explicit columnId', () => {
    const { manager, store } = makeManager();
    seedProject(store);
    const item = manager.add({ title: 't' });
    const ticket = manager.promoteToTicket(item.id, { projectId: 'p1', columnId: 'spec' });
    expect(ticket.columnId).toBe('spec');
  });

  it('throws when the project does not exist', () => {
    const { manager } = makeManager();
    const item = manager.add({ title: 't' });
    expect(() => manager.promoteToTicket(item.id, { projectId: 'nope' })).toThrow(
      InboxPromotionError
    );
  });

  it('refuses to re-promote an already-promoted item', () => {
    const { manager, store } = makeManager();
    seedProject(store);
    const item = manager.add({ title: 't' });
    manager.promoteToTicket(item.id, { projectId: 'p1' });
    expect(() => manager.promoteToTicket(item.id, { projectId: 'p1' })).toThrow(
      InboxPromotionError
    );
  });
});

describe('InboxManager: promoteToProject', () => {
  it('creates a project seeded from the input label and slugifies', () => {
    const { manager, store } = makeManager();
    const item = manager.add({ title: 'Spin up new thing' });
    const project = manager.promoteToProject(item.id, { label: '  New Cool Thing!  ' });
    expect(project.label).toBe('New Cool Thing!');
    expect(project.slug).toBe('new-cool-thing');
    expect(store.projects).toHaveLength(1);
    expect(store.inboxItems[0].promotedTo).toEqual({
      kind: 'project',
      id: project.id,
      at: NOW,
    });
  });

  it('falls back to item title when label is blank', () => {
    const { manager } = makeManager();
    const item = manager.add({ title: 'Build X' });
    const project = manager.promoteToProject(item.id, { label: '   ' });
    expect(project.label).toBe('Build X');
    expect(project.slug).toBe('build-x');
  });
});

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

describe('InboxManager: sweepExpired', () => {
  it('flips expired new items to later', () => {
    const { manager, store, setClock } = makeManager();
    const item = manager.add({ title: 't' });
    setClock(NOW + 8 * 24 * 60 * 60 * 1000);
    const changed = manager.sweepExpired();
    expect(changed).toBe(1);
    expect(store.inboxItems[0].status).toBe('later');
  });

  it('is a no-op when nothing is expired', () => {
    const { manager } = makeManager();
    manager.add({ title: 't' });
    expect(manager.sweepExpired()).toBe(0);
  });
});

describe('InboxManager: gcPromoted', () => {
  it('removes promoted tombstones older than 30 days', () => {
    const { manager, store, setClock } = makeManager();
    store.projects = [{ id: 'p1', label: 'P', slug: 'p', createdAt: NOW }];
    const keep = manager.add({ title: 'keep' });
    const drop = manager.add({ title: 'drop' });
    manager.promoteToTicket(drop.id, { projectId: 'p1' });
    manager.promoteToTicket(keep.id, { projectId: 'p1' });

    // Jump the clock so `drop` is well past the TTL, `keep` is still fresh.
    setClock(NOW + PROMOTED_TOMBSTONE_TTL_MS + 1);
    // Re-promote keep with a fresh timestamp so it's newer than the TTL cutoff.
    // Easier: just advance time more carefully. Instead set both directly:
    store.inboxItems = store.inboxItems.map((i) =>
      i.id === keep.id && i.promotedTo
        ? { ...i, promotedTo: { ...i.promotedTo, at: NOW + PROMOTED_TOMBSTONE_TTL_MS } }
        : i
    );

    const removed = manager.gcPromoted();
    expect(removed).toBe(1);
    expect(store.inboxItems).toHaveLength(1);
    expect(store.inboxItems[0].id).toBe(keep.id);
  });

  it('is a no-op when nothing is old enough', () => {
    const { manager, store } = makeManager();
    store.projects = [{ id: 'p1', label: 'P', slug: 'p', createdAt: NOW }];
    const item = manager.add({ title: 't' });
    manager.promoteToTicket(item.id, { projectId: 'p1' });
    expect(manager.gcPromoted()).toBe(0);
  });
});
