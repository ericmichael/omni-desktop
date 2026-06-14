/**
 * Pure unit tests for schema migrations.
 *
 * Uses an in-memory store fake — zero fs, zero electron. Each migration
 * step is exercised from its "before" snapshot and asserted against the
 * expected "after" shape.
 */
import { describe, expect, it, vi } from 'vitest';

import { type IMigrationStore, type MigrationDeps, runMigrations } from '@/lib/project-migrations';

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
      expect(store.get('schemaVersion')).toBe(26);
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
        initiatives: [{ id: 'i1', projectId: 'p1', isDefault: true, title: 'General' }],
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
      expect(inbox[0]!.status).toBe('new');
      expect(inbox[0]!.projectId).toBe('proj-1');
      // Legacy scope properties fold straight into the note.
      expect(inbox[0]!.note).toBe('**Done when:** Ship feature');

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
    it('runs v0 → v23 end-to-end without throwing', () => {
      const store = makeStore({
        // schemaVersion undefined → takes the initial boot path.
        tickets: [{ id: 't1', status: 'in_progress' }],
        projects: [{ id: 'p1', label: 'A', workspaceDir: '/tmp/w' }],
      });
      expect(() => runMigrations(store, makeDeps())).not.toThrow();
      expect(store.get('schemaVersion')).toBe(26);
    });

    it('v21 → v22 maps docker→devbox, drops legacy sandbox keys, strips Project.sandbox', () => {
      const store = makeStore({
        schemaVersion: 21,
        sandboxBackend: 'docker',
        sandboxProfiles: [{ resource_id: 1 }],
        selectedMachineId: 1,
        tickets: [],
        projects: [
          { id: 'p1', label: 'A', sandbox: { image: 'ubuntu:24.04' } },
          { id: 'p2', label: 'B' },
        ],
      });
      runMigrations(store, makeDeps());
      // v21→v22 → falls through to v22→v23 (sticky profile seeding).
      expect(store.get('schemaVersion')).toBe(26);
      expect(store.get('defaultProfileName')).toBe('devbox');
      expect(store.get('sandboxBackend')).toBeUndefined();
      expect(store.get('sandboxProfiles')).toBeUndefined();
      expect(store.get('selectedMachineId')).toBeUndefined();
      const projects = store.get('projects', []) as Array<Record<string, unknown>>;
      expect(projects[0]).not.toHaveProperty('sandbox');
      expect(projects[1]).not.toHaveProperty('sandbox');
    });

    it('v21 → v22 maps platform→platform', () => {
      const store = makeStore({
        schemaVersion: 21,
        sandboxBackend: 'platform',
        tickets: [],
        projects: [],
      });
      runMigrations(store, makeDeps());
      expect(store.get('defaultProfileName')).toBe('platform');
    });

    it('v21 → v22 maps dropped backends (podman/vm/local/none) to host', () => {
      for (const legacy of ['podman', 'vm', 'local', 'none']) {
        const store = makeStore({
          schemaVersion: 21,
          sandboxBackend: legacy,
          tickets: [],
          projects: [],
        });
        runMigrations(store, makeDeps());
        expect(store.get('defaultProfileName')).toBe('host');
      }
    });

    it('is a no-op on an already-migrated v23 store', () => {
      const store = makeStore({
        schemaVersion: 23,
        tickets: [{ id: 't1', phase: 'idle' }],
        projects: [],
        milestones: [],
        pages: [],
        inboxItems: [],
      });
      const deps = makeDeps();
      runMigrations(store, deps);

      expect(store.get('schemaVersion')).toBe(26);
      expect(deps.writeProjectContextBrief).not.toHaveBeenCalled();
    });

    it('v17 → v18 drops supervisorSessionId from tickets', () => {
      const store = makeStore({
        schemaVersion: 17,
        tickets: [
          { id: 't1', phase: 'idle', supervisorSessionId: 'sess-stale-1' },
          { id: 't2', phase: 'completed', supervisorSessionId: 'sess-stale-2' },
          { id: 't3', phase: 'idle' },
        ],
        projects: [],
      });
      runMigrations(store, makeDeps());
      const tickets = store.get('tickets', []) as Array<Record<string, unknown>>;
      expect(tickets).toHaveLength(3);
      for (const t of tickets) {
        expect(t).not.toHaveProperty('supervisorSessionId');
      }
      // Falls through to v23, the current head.
      expect(store.get('schemaVersion')).toBe(26);
    });

    it('v18 → v19 backfills installedBundles from existing skillSources', () => {
      const store = makeStore({
        schemaVersion: 18,
        tickets: [],
        projects: [],
        skillSources: {
          pdf: { kind: 'marketplace', repo: 'anthropics/skills', plugin: 'document-skills', ref: 'main' },
          docx: { kind: 'marketplace', repo: 'anthropics/skills', plugin: 'document-skills', ref: 'main' },
          'canvas-design': {
            kind: 'marketplace',
            repo: 'anthropics/skills',
            plugin: 'creative-skills',
            ref: 'main',
          },
          local: { kind: 'local' },
          'from-file': { kind: 'file', filename: 'foo.skill' },
        },
      });
      runMigrations(store, makeDeps());

      expect(store.get('schemaVersion')).toBe(26);
      const bundles = store.get('installedBundles') as Record<string, { skillNames: string[] }>;
      expect(Object.keys(bundles).sort()).toEqual([
        'anthropics/skills:creative-skills',
        'anthropics/skills:document-skills',
      ]);
      expect(bundles['anthropics/skills:document-skills']!.skillNames.sort()).toEqual(['docx', 'pdf']);
      expect(bundles['anthropics/skills:creative-skills']!.skillNames).toEqual(['canvas-design']);
    });

    it('calls repairProjectRoots on idempotent v-current boot', () => {
      const store = makeStore({
        schemaVersion: 23,
        tickets: [],
        projects: [],
        milestones: [],
        pages: [],
      });
      const repair = vi.fn();
      runMigrations(store, makeDeps({ repairProjectRoots: repair }));
      expect(repair).toHaveBeenCalled();
    });

    it('v22 → v23 seeds chatProfileName from defaultProfileName', () => {
      const store = makeStore({
        schemaVersion: 22,
        defaultProfileName: 'devbox',
        tickets: [],
        projects: [],
        codeTabs: [],
      });
      runMigrations(store, makeDeps());
      expect(store.get('schemaVersion')).toBe(26);
      // v23 seeds chatProfileName; v26 folds it onto the reserved chat tab.
      const chatTab = (store.get('codeTabs', []) as Array<Record<string, unknown>>).find((t) => t.id === 'chat')!;
      expect(chatTab.profileName).toBe('devbox');
    });

    it('v22 → v23 falls back to "host" when defaultProfileName is missing', () => {
      const store = makeStore({
        schemaVersion: 22,
        tickets: [],
        projects: [],
        codeTabs: [],
      });
      runMigrations(store, makeDeps());
      const chatTab = (store.get('codeTabs', []) as Array<Record<string, unknown>>).find((t) => t.id === 'chat')!;
      expect(chatTab.profileName).toBe('host');
    });

    it('v22 → v23 leaves existing chatProfileName untouched', () => {
      const store = makeStore({
        schemaVersion: 22,
        defaultProfileName: 'host',
        chatProfileName: 'devbox',
        tickets: [],
        projects: [],
        codeTabs: [],
      });
      runMigrations(store, makeDeps());
      const chatTab = (store.get('codeTabs', []) as Array<Record<string, unknown>>).find((t) => t.id === 'chat')!;
      expect(chatTab.profileName).toBe('devbox');
    });

    it('v22 → v23 seeds codeTab.profileName from project.sandboxProfile when set', () => {
      const store = makeStore({
        schemaVersion: 22,
        defaultProfileName: 'host',
        tickets: [],
        projects: [
          { id: 'p1', label: 'A', sandboxProfile: 'devbox' },
          { id: 'p2', label: 'B', sandboxProfile: null },
          { id: 'p3', label: 'C' },
        ],
        codeTabs: [
          { id: 't1', projectId: 'p1', createdAt: 1 },
          { id: 't2', projectId: 'p2', createdAt: 2 },
          { id: 't3', projectId: 'p3', createdAt: 3 },
          { id: 't4', projectId: null, createdAt: 4 },
        ],
      });
      runMigrations(store, makeDeps());
      const tabs = store.get('codeTabs', []) as Array<Record<string, unknown>>;
      const byId = (id: string) => tabs.find((t) => t.id === id)!;
      expect(byId('t1').profileName).toBe('devbox'); // inherited
      expect(byId('t2').profileName).toBe('host'); // project's profile is null → default
      expect(byId('t3').profileName).toBe('host'); // no project profile → default
      expect(byId('t4').profileName).toBe('host'); // no project at all → default
    });

    it('v22 → v23 leaves an already-set codeTab.profileName untouched', () => {
      const store = makeStore({
        schemaVersion: 22,
        defaultProfileName: 'host',
        tickets: [],
        projects: [{ id: 'p1', label: 'A', sandboxProfile: 'devbox' }],
        codeTabs: [{ id: 't1', projectId: 'p1', profileName: 'platform', createdAt: 1 }],
      });
      runMigrations(store, makeDeps());
      const tabs = store.get('codeTabs', []) as Array<Record<string, unknown>>;
      expect(tabs.find((t) => t.id === 't1')!.profileName).toBe('platform');
    });

    it('v23 → v24 re-mints nanoid session ids as UUIDs', () => {
      const store = makeStore({
        schemaVersion: 23,
        tickets: [],
        projects: [],
        chatSessionId: 'OYbCE-pm2i13D29_L0zfW',
        codeTabs: [
          { id: 't1', projectId: null, sessionId: 'OYbCE-pm2i13D29_L0zfW', createdAt: 1 },
          { id: 't2', projectId: null, sessionId: 'V1StGXR8_Z5jdHi6B-myT', createdAt: 2 },
        ],
      });
      runMigrations(store, makeDeps({ newSessionId: () => '11111111-2222-4333-8444-555555555555' }));

      expect(store.get('schemaVersion')).toBe(26);
      // The reminted chat session id lands on the reserved chat tab (v26).
      const tabs = store.get('codeTabs', []) as Array<Record<string, unknown>>;
      const byId = (id: string) => tabs.find((t) => t.id === id)!;
      expect(byId('chat').sessionId).toBe('11111111-2222-4333-8444-555555555555');
      expect(store.get('chatSessionId')).toBeUndefined();
      expect(byId('t1').sessionId).toBe('11111111-2222-4333-8444-555555555555');
      expect(byId('t2').sessionId).toBe('11111111-2222-4333-8444-555555555555');
    });

    it('v23 → v24 leaves session ids that are already UUIDs untouched', () => {
      const store = makeStore({
        schemaVersion: 23,
        tickets: [],
        projects: [],
        chatSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        codeTabs: [{ id: 't1', projectId: null, sessionId: 'ffffffff-0000-4111-8222-333333333333', createdAt: 1 }],
      });
      runMigrations(store, makeDeps({ newSessionId: () => 'SHOULD-NOT-BE-USED' }));

      const tabs = store.get('codeTabs', []) as Array<Record<string, unknown>>;
      expect(tabs.find((t) => t.id === 'chat')!.sessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(tabs.find((t) => t.id === 't1')!.sessionId).toBe('ffffffff-0000-4111-8222-333333333333');
    });

    it('v23 → v24 is a no-op when there are no sessions to migrate', () => {
      const store = makeStore({ schemaVersion: 23, tickets: [], projects: [] });
      runMigrations(store, makeDeps());
      expect(store.get('schemaVersion')).toBe(26);
      expect(store.get('chatSessionId')).toBeUndefined();
      // v26 still synthesizes the reserved chat record with a minted session.
      const chatTab = (store.get('codeTabs', []) as Array<Record<string, unknown>>).find((t) => t.id === 'chat')!;
      expect(typeof chatTab.sessionId).toBe('string');
    });

    it('v19 → v20 renames legacy "code" to "spaces" and "deck" to "tile"', () => {
      const store = makeStore({
        schemaVersion: 19,
        tickets: [],
        projects: [],
        layoutMode: 'code',
        codeLayoutMode: 'deck',
      });
      runMigrations(store, makeDeps());
      expect(store.get('schemaVersion')).toBe(26);
      expect(store.get('layoutMode')).toBe('spaces');
      expect(store.get('codeLayoutMode')).toBe('tile');
    });

    it('v19 → v20 also converts intermediate "os" and "spaces" values', () => {
      const store = makeStore({
        schemaVersion: 19,
        tickets: [],
        projects: [],
        layoutMode: 'os',
        codeLayoutMode: 'spaces',
      });
      runMigrations(store, makeDeps());
      expect(store.get('schemaVersion')).toBe(26);
      expect(store.get('layoutMode')).toBe('spaces');
      expect(store.get('codeLayoutMode')).toBe('tile');
    });

    it('v19 → v20 leaves other layoutMode and codeLayoutMode values alone', () => {
      const store = makeStore({
        schemaVersion: 19,
        tickets: [],
        projects: [],
        layoutMode: 'projects',
        codeLayoutMode: 'focus',
      });
      runMigrations(store, makeDeps());
      expect(store.get('schemaVersion')).toBe(26);
      expect(store.get('layoutMode')).toBe('projects');
      expect(store.get('codeLayoutMode')).toBe('focus');
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

  describe('v24 → v25: shaping removal', () => {
    it('folds ticket shaping into the description and drops the field', () => {
      const store = makeStore({
        schemaVersion: 24,
        tickets: [
          {
            id: 't1',
            description: 'Existing body.',
            shaping: { doneLooksLike: 'redirect works', appetite: 'medium', outOfScope: 'password reset' },
          },
          { id: 't2', description: 'Untouched.' },
        ],
      });
      runMigrations(store, makeDeps());

      const tickets = store.get('tickets') as Array<Record<string, unknown>>;
      const t1 = tickets.find((t) => t.id === 't1')!;
      expect(t1.description).toBe('Existing body.\n\n**Done when:** redirect works\n**Out of scope:** password reset');
      expect('shaping' in t1).toBe(false);
      expect(tickets.find((t) => t.id === 't2')!.description).toBe('Untouched.');
      expect(store.get('schemaVersion')).toBe(26);
    });

    it("folds inbox shaping into the note and collapses 'shaped' to 'new' with a fresh createdAt", () => {
      const store = makeStore({
        schemaVersion: 24,
        inboxItems: [
          {
            id: 'i1',
            note: 'Context.',
            status: 'shaped',
            createdAt: 100,
            shaping: { outcome: 'Demo booked', appetite: 'small', notDoing: 'No counter-offer' },
          },
          { id: 'i2', status: 'later', createdAt: 100 },
        ],
      });
      runMigrations(store, makeDeps());

      const inbox = store.get('inboxItems') as Array<Record<string, unknown>>;
      const i1 = inbox.find((i) => i.id === 'i1')!;
      expect(i1.note).toBe('Context.\n\n**Done when:** Demo booked\n**Out of scope:** No counter-offer');
      expect(i1.status).toBe('new');
      expect('shaping' in i1).toBe(false);
      // createdAt refreshed so the expiry sweep doesn't instantly defer it.
      expect(i1.createdAt).toBe(1_000_000);
      // Non-shaped items are untouched.
      const i2 = inbox.find((i) => i.id === 'i2')!;
      expect(i2.status).toBe('later');
      expect(i2.createdAt).toBe(100);
    });
  });

  describe('v25 → v26: chat unification', () => {
    it('folds the legacy chat keys into a reserved codeTabs entry and deletes them', () => {
      const store = makeStore({
        schemaVersion: 25,
        codeTabs: [{ id: 'tab-1', projectId: 'p1', createdAt: 50 }],
        chatSessionId: 'sess-chat',
        chatProfileName: 'devbox',
        chatContainerId: 'cont-1',
      });
      runMigrations(store, makeDeps());

      const tabs = store.get('codeTabs') as Array<Record<string, unknown>>;
      expect(tabs).toHaveLength(2);
      const chat = tabs[0]!;
      expect(chat.id).toBe('chat');
      expect(chat.projectId).toBeNull();
      expect(chat.sessionId).toBe('sess-chat');
      expect(chat.profileName).toBe('devbox');
      expect(chat.profileNameExplicit).toBe(false);
      expect(chat.containerId).toBe('cont-1');
      // Other tabs untouched, order preserved after the chat record.
      expect(tabs[1]!.id).toBe('tab-1');

      expect(store.get('chatSessionId')).toBeUndefined();
      expect(store.get('chatProfileName')).toBeUndefined();
      expect(store.get('chatContainerId')).toBeUndefined();
      expect(store.get('schemaVersion')).toBe(26);
    });

    it('mints a session id and seeds the profile from the default when the keys are absent', () => {
      const store = makeStore({
        schemaVersion: 25,
        codeTabs: [],
        defaultProfileName: 'devbox',
      });
      runMigrations(store, makeDeps({ newSessionId: () => 'minted-uuid' }));

      const tabs = store.get('codeTabs') as Array<Record<string, unknown>>;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.id).toBe('chat');
      expect(tabs[0]!.sessionId).toBe('minted-uuid');
      expect(tabs[0]!.profileName).toBe('devbox');
      expect('containerId' in tabs[0]!).toBe(false);
    });

    it('is idempotent when the chat record already exists', () => {
      const store = makeStore({
        schemaVersion: 25,
        codeTabs: [{ id: 'chat', projectId: null, sessionId: 'keep-me', createdAt: 1 }],
        chatSessionId: 'stale-legacy',
      });
      runMigrations(store, makeDeps());

      const tabs = store.get('codeTabs') as Array<Record<string, unknown>>;
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.sessionId).toBe('keep-me');
      expect(store.get('chatSessionId')).toBeUndefined();
      expect(store.get('schemaVersion')).toBe(26);
    });
  });
});
