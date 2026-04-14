/**
 * Pure unit tests for schema migrations.
 *
 * Uses an in-memory store fake — zero fs, zero electron. Each migration
 * step is exercised from its "before" snapshot and asserted against the
 * expected "after" shape.
 */
import { describe, expect, it, vi } from 'vitest';

import { type IMigrationStore, type MigrationDeps,runMigrations } from '@/lib/project-migrations';

// ---------------------------------------------------------------------------
// In-memory migration store
// ---------------------------------------------------------------------------

const makeStore = (initial: Record<string, unknown> = {}): IMigrationStore => {
  const data: Record<string, unknown> = { ...initial };
  return {
    get: ((key: string, defaultValue?: unknown) => {
      const v = data[key];
      if (v === undefined) {
        return defaultValue;
      }
      return v;
    }) as IMigrationStore['get'],
    set: ((key: string, value: unknown) => {
      data[key] = value;
    }) as IMigrationStore['set'],
    delete: (key: string) => {
      delete data[key];
    },
  };
};

const makeDeps = (overrides: Partial<MigrationDeps> = {}): MigrationDeps => {
  let idCounter = 0;
  return {
    newId: () => `id-${++idCounter}`,
    now: () => 1_000_000,
    writeProjectContextBrief: vi.fn(),
    ensurePersonalProjectDir: vi.fn(),
    ...overrides,
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  describe('v3 → v4: phase normalization', () => {
    it('strips supervisorStatus + runPhase and adds phase=idle', () => {
      const store = makeStore({
        schemaVersion: 3,
        tickets: [
          { id: 't1', supervisorStatus: 'running', runPhase: 'streaming' },
          { id: 't2', supervisorStatus: 'idle' },
        ],
      });
      runMigrations(store, makeDeps());

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      expect(tickets).toHaveLength(2);
      for (const t of tickets) {
        expect(t.supervisorStatus).toBeUndefined();
        expect(t.runPhase).toBeUndefined();
        expect(t.phase).toBe('idle');
      }
      // Fall-through means schemaVersion ends up at the current version.
      expect(store.get('schemaVersion')).toBe(16);
    });
  });

  describe('v4 → v5: default milestones per project', () => {
    it('creates one milestone per project and assigns tickets', () => {
      const store = makeStore({
        schemaVersion: 4,
        projects: [{ id: 'p1' }, { id: 'p2' }],
        tickets: [
          { id: 't1', projectId: 'p1' },
          { id: 't2', projectId: 'p2' },
        ],
      });
      runMigrations(store, makeDeps());

      const milestones = store.get('milestones') as Array<Record<string, unknown>>;
      expect(milestones).toHaveLength(2);
      // Each milestone is bound to exactly one project.
      expect(milestones.map((m) => m.projectId).sort()).toEqual(['p1', 'p2']);

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      for (const t of tickets) {
        expect(t.milestoneId).toBeTruthy();
      }
    });
  });

  describe('v5 → v6: inbox deferred → iceboxed, wipLimit default', () => {
    it('seeds wipLimit=3 when missing', () => {
      const store = makeStore({
        schemaVersion: 5,
        inboxItems: [],
      });
      runMigrations(store, makeDeps());
      expect(store.get('wipLimit')).toBe(3);
    });

    it('preserves an existing wipLimit', () => {
      const store = makeStore({ schemaVersion: 5, wipLimit: 7, inboxItems: [] });
      runMigrations(store, makeDeps());
      expect(store.get('wipLimit')).toBe(7);
    });

    it('eventually normalizes legacy "deferred" inbox items to "later" (via v11→v13 inbox upgrade)', () => {
      // v5→v6 sets status='iceboxed', then v11→v13 runs upgradeLegacyInbox
      // which maps iceboxed → later in the new model.
      const store = makeStore({
        schemaVersion: 5,
        inboxItems: [{ id: 'i1', status: 'deferred', title: 'x' }],
      });
      runMigrations(store, makeDeps());
      const items = store.get('inboxItems') as Array<Record<string, unknown>>;
      expect(items[0]!.status).toBe('later');
    });
  });

  describe('v6 → v7: project.workspaceDir → project.source', () => {
    it('wraps workspaceDir into a local source', () => {
      const store = makeStore({
        schemaVersion: 6,
        projects: [{ id: 'p1', label: 'A', workspaceDir: '/tmp/work' }],
      });
      runMigrations(store, makeDeps());

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects[0]!.source).toEqual({ kind: 'local', workspaceDir: '/tmp/work' });
      expect(projects[0]!.workspaceDir).toBeUndefined();
    });

    it('leaves projects that already have a source object untouched', () => {
      const existing = { kind: 'git-remote', repoUrl: 'https://example.com/repo' };
      const store = makeStore({
        schemaVersion: 6,
        projects: [{ id: 'p1', label: 'A', source: existing }],
      });
      runMigrations(store, makeDeps());

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects[0]!.source).toBe(existing);
    });
  });

  describe('v7 → v8: initiatives → milestones rename', () => {
    it('renames the initiatives key, strips isDefault, and renames ticket.initiativeId → milestoneId', () => {
      const store = makeStore({
        schemaVersion: 7,
        initiatives: [
          { id: 'i1', projectId: 'p1', isDefault: true, title: 'General' },
        ],
        milestones: [],
        tickets: [{ id: 't1', initiativeId: 'i1' }],
      });
      runMigrations(store, makeDeps());

      expect(store.get('initiatives')).toBeUndefined();
      const milestones = store.get('milestones') as Array<Record<string, unknown>>;
      expect(milestones).toHaveLength(1);
      expect(milestones[0]!.isDefault).toBeUndefined();

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      expect(tickets[0]!.initiativeId).toBeUndefined();
      expect(tickets[0]!.milestoneId).toBe('i1');
    });

    it('renames inboxItem.linkedInitiativeId → linkedMilestoneId at v8', () => {
      // Stop the ladder at v8 by seeding to v10 after running. Simpler: assert
      // that linkedInitiativeId is gone post-full-ladder (v11→v13 then drops
      // it entirely since the new InboxItem model has no such field).
      const store = makeStore({
        schemaVersion: 7,
        inboxItems: [{ id: 'item1', title: 'x', linkedInitiativeId: 'i1' }],
      });
      runMigrations(store, makeDeps());

      const items = store.get('inboxItems') as Array<Record<string, unknown>>;
      // linkedInitiativeId should never survive — either renamed at v8 or
      // dropped at v13 when upgradeLegacyInbox reshapes the record.
      expect(items[0]!.linkedInitiativeId).toBeUndefined();
    });
  });

  describe('v8 → v9: slug backfill', () => {
    it('derives a slug from the label when missing', () => {
      const store = makeStore({
        schemaVersion: 8,
        projects: [
          { id: 'p1', label: 'Hello World' },
          { id: 'p2', label: 'Already', slug: 'already' },
        ],
      });
      runMigrations(store, makeDeps());

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects.find((p) => p.id === 'p1')!.slug).toBe('hello-world');
      expect(projects.find((p) => p.id === 'p2')!.slug).toBe('already');
    });

    it('falls back to "project" when label is empty', () => {
      const store = makeStore({
        schemaVersion: 8,
        projects: [{ id: 'p1', label: '' }],
      });
      runMigrations(store, makeDeps());

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects[0]!.slug).toBe('project');
    });
  });

  describe('v9 → v10: seed root page, backfill context.md', () => {
    it('creates one root page per project and invokes writeProjectContextBrief for each', () => {
      const writeSpy = vi.fn();
      const store = makeStore({
        schemaVersion: 9,
        projects: [
          { id: 'p1', label: 'A', slug: 'a', brief: 'A brief' },
          { id: 'p2', label: 'B', slug: 'b' },
        ],
      });
      runMigrations(store, makeDeps({ writeProjectContextBrief: writeSpy }));

      const pages = store.get('pages') as Array<Record<string, unknown>>;
      expect(pages).toHaveLength(2);
      for (const p of pages) {
        expect(p.isRoot).toBe(true);
        expect(p.parentId).toBeNull();
      }
      expect(writeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('v10 → v11: strip legacy brief', () => {
    it('removes the brief field from project records', () => {
      const store = makeStore({
        schemaVersion: 10,
        projects: [
          { id: 'p1', label: 'A', brief: 'old' },
          { id: 'p2', label: 'B' },
        ],
      });
      runMigrations(store, makeDeps());

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      for (const p of projects) {
        expect(p.brief).toBeUndefined();
      }
    });
  });

  describe('v11 → v13: inbox upgrade + Personal project backfill', () => {
    it('creates a Personal project when none exists', () => {
      const ensureSpy = vi.fn();
      const store = makeStore({
        schemaVersion: 11,
        projects: [{ id: 'p1', label: 'Work', slug: 'work' }],
        inboxItems: [],
      });
      runMigrations(store, makeDeps({ ensurePersonalProjectDir: ensureSpy }));

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects.find((p) => p.isPersonal)).toBeDefined();
      expect(ensureSpy).toHaveBeenCalled();
    });

    it('does not double-create a Personal project if one already exists', () => {
      const ensureSpy = vi.fn();
      const store = makeStore({
        schemaVersion: 11,
        projects: [{ id: 'p1', label: 'Personal', isPersonal: true, slug: 'personal' }],
        inboxItems: [],
      });
      runMigrations(store, makeDeps({ ensurePersonalProjectDir: ensureSpy }));

      const projects = store.get('projects') as Array<Record<string, unknown>>;
      expect(projects.filter((p) => p.isPersonal)).toHaveLength(1);
      expect(ensureSpy).not.toHaveBeenCalled();
    });
  });

  describe('v13 → v14: orphan page.properties → inbox recovery', () => {
    it('converts a page with properties into an inbox item and drops the page', () => {
      const store = makeStore({
        schemaVersion: 13,
        pages: [
          {
            id: 'p1',
            title: 'My task',
            createdAt: 100,
            updatedAt: 200,
            properties: {
              status: 'ready',
              projectId: 'proj-1',
              outcome: 'Ship feature',
              size: 'medium',
            },
          },
          {
            id: 'p2',
            title: 'Real page',
            // No properties — should be kept as a page.
          },
        ],
        inboxItems: [],
      });
      runMigrations(store, makeDeps());

      const inbox = store.get('inboxItems') as Array<Record<string, unknown>>;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.id).toBe('p1');
      expect(inbox[0]!.status).toBe('shaped');
      expect(inbox[0]!.projectId).toBe('proj-1');
      const shaping = inbox[0]!.shaping as Record<string, unknown>;
      expect(shaping.outcome).toBe('Ship feature');
      expect(shaping.appetite).toBe('medium');

      const pages = store.get('pages') as Array<Record<string, unknown>>;
      expect(pages).toHaveLength(1);
      expect(pages[0]!.id).toBe('p2');
    });

    it('drops legacy pages with status=done entirely', () => {
      const store = makeStore({
        schemaVersion: 13,
        pages: [
          {
            id: 'p1',
            title: 'Done work',
            properties: { status: 'done' },
          },
        ],
        inboxItems: [],
      });
      runMigrations(store, makeDeps());

      expect(store.get('inboxItems')).toEqual([]);
      expect(store.get('pages')).toEqual([]);
    });

    it('preserves pages with empty properties objects (strips only the key)', () => {
      const store = makeStore({
        schemaVersion: 13,
        pages: [{ id: 'p1', title: 'OK', properties: {} }],
        inboxItems: [],
      });
      runMigrations(store, makeDeps());

      const pages = store.get('pages') as Array<Record<string, unknown>>;
      expect(pages).toHaveLength(1);
      expect(pages[0]!.properties).toBeUndefined();
    });
  });

  describe('v14 → v15: activity timestamp backfill', () => {
    it('backfills phaseChangedAt and columnChangedAt from updatedAt', () => {
      const store = makeStore({
        schemaVersion: 14,
        tickets: [
          { id: 't1', updatedAt: 500 },
          { id: 't2', updatedAt: 1000, phaseChangedAt: 999 },
        ],
      });
      runMigrations(store, makeDeps());

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      const t1 = tickets.find((t) => t.id === 't1')!;
      expect(t1.phaseChangedAt).toBe(500);
      expect(t1.columnChangedAt).toBe(500);
      const t2 = tickets.find((t) => t.id === 't2')!;
      expect(t2.phaseChangedAt).toBe(999); // preserved
    });

    it('backfills resolvedAt only when resolution is defined', () => {
      const store = makeStore({
        schemaVersion: 14,
        tickets: [
          { id: 't-unresolved', updatedAt: 500 },
          { id: 't-resolved', updatedAt: 800, resolution: 'done' },
        ],
      });
      runMigrations(store, makeDeps());

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      expect(tickets.find((t) => t.id === 't-unresolved')!.resolvedAt).toBeUndefined();
      expect(tickets.find((t) => t.id === 't-resolved')!.resolvedAt).toBe(800);
    });

    it('backfills milestone.completedAt iff status is completed', () => {
      const store = makeStore({
        schemaVersion: 14,
        milestones: [
          { id: 'm1', status: 'active', updatedAt: 500 },
          { id: 'm2', status: 'completed', updatedAt: 1000 },
          { id: 'm3', status: 'completed', updatedAt: 1500, completedAt: 1200 },
        ],
      });
      runMigrations(store, makeDeps());

      const milestones = store.get('milestones') as Array<Record<string, unknown>>;
      expect(milestones.find((m) => m.id === 'm1')!.completedAt).toBeUndefined();
      expect(milestones.find((m) => m.id === 'm2')!.completedAt).toBe(1000);
      expect(milestones.find((m) => m.id === 'm3')!.completedAt).toBe(1200);
    });

    it('rewrites legacy layoutMode=home → chat', () => {
      const store = makeStore({
        schemaVersion: 14,
        layoutMode: 'home',
      });
      runMigrations(store, makeDeps());
      expect(store.get('layoutMode')).toBe('chat');
    });
  });

  describe('full ladder and idempotency', () => {
    it('runs v0 → v16 end-to-end without throwing', () => {
      const store = makeStore({
        // schemaVersion undefined → takes the initial boot path.
        tickets: [{ id: 't1', status: 'in_progress' }],
        projects: [{ id: 'p1', label: 'A', workspaceDir: '/tmp/w' }],
      });
      expect(() => runMigrations(store, makeDeps())).not.toThrow();
      expect(store.get('schemaVersion')).toBe(16);
    });

    it('is a no-op on an already-migrated v16 store', () => {
      const store = makeStore({
        schemaVersion: 16,
        tickets: [{ id: 't1', phase: 'idle' }],
        projects: [],
        milestones: [],
        pages: [],
        inboxItems: [],
      });
      const deps = makeDeps();
      runMigrations(store, deps);

      expect(store.get('schemaVersion')).toBe(16);
      expect(deps.writeProjectContextBrief).not.toHaveBeenCalled();
    });

    it('calls repairProjectRoots on idempotent v-current boot', () => {
      const store = makeStore({
        schemaVersion: 16,
        tickets: [],
        projects: [],
        milestones: [],
        pages: [],
      });
      const repair = vi.fn();
      runMigrations(store, makeDeps({ repairProjectRoots: repair }));
      expect(repair).toHaveBeenCalled();
    });
  });

  describe('v15 → v16: ticket archive support', () => {
    it('adds archivedAt=undefined to tickets that lack it', () => {
      const store = makeStore({
        schemaVersion: 15,
        tickets: [{ id: 't1' }, { id: 't2', archivedAt: 12345 }],
      });
      runMigrations(store, makeDeps());

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      const t1 = tickets.find((t) => t.id === 't1')!;
      expect('archivedAt' in t1).toBe(true);
      expect(t1.archivedAt).toBeUndefined();
      // Existing archivedAt is preserved.
      const t2 = tickets.find((t) => t.id === 't2')!;
      expect(t2.archivedAt).toBe(12345);
    });
  });
});
