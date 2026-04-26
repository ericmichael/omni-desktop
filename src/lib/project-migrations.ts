/**
 * Pure schema migrations for the ProjectManager store.
 *
 * Extracted from `ProjectManager.migrateToSupervisor` so each migration step
 * can be unit-tested in isolation without touching the real filesystem.
 *
 * Side effects on the filesystem (v10 brief → context.md backfill, v12 Personal
 * project dir) are injected through `MigrationDeps` so tests can pass no-ops
 * and the live main-process path can wire real fs writes.
 */
import { upgradeLegacyInbox } from '@/lib/inbox-migration';
import type {
  ColumnId,
  InboxItem,
  InboxShaping,
  Milestone,
  StoreData,
  TicketId,
  TicketPriority,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Narrow store interface — anything that implements this can be migrated.
// electron-store implements it natively; tests use an in-memory fake.
// ---------------------------------------------------------------------------

export interface IMigrationStore {
  get<K extends keyof StoreData>(key: K): StoreData[K] | undefined;
  get<K extends keyof StoreData>(key: K, defaultValue: StoreData[K]): StoreData[K];
  get(key: string): unknown;
  get(key: string, defaultValue: unknown): unknown;
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export interface MigrationDeps {
  /** Mint an id (nanoid in production, deterministic in tests). */
  newId: () => string;
  /** Current wall-clock time (Date.now in production, frozen in tests). */
  now: () => number;
  /**
   * v10 backfill: write `<projectDir>/context.md` using the project's legacy
   * `brief` field. No-op by default so tests don't touch disk.
   */
  writeProjectContextBrief?: (project: {
    id: string;
    label: string;
    slug?: string;
    isPersonal?: boolean;
    brief?: string;
  }) => void;
  /**
   * v12 backfill: ensure the Personal project's workspace directory exists
   * and has a default context.md. No-op by default.
   */
  ensurePersonalProjectDir?: () => void;
  /**
   * Post-migration repair pass: re-seed missing root pages and re-create
   * any missing context.md files. Called after each schema-version bump
   * and once on the idempotent v-current path. No-op by default.
   */
  repairProjectRoots?: () => void;
}

const DEFAULT_BRIEF_TEMPLATE = `## Problem


## Appetite


## Solution direction


## Open questions
- [ ]

## Decisions


## Out of scope

`;

// ---------------------------------------------------------------------------
// Migration entry point
// ---------------------------------------------------------------------------

export function runMigrations(store: IMigrationStore, deps: MigrationDeps): void {
  const version = (store.get('schemaVersion', 0) as number) ?? 0;

  // v3 → v4: replace supervisorStatus + runPhase with phase
  if (version === 3) {
    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
    const migrated = tickets.map((raw) => {
      const { supervisorStatus: _s, runPhase: _r, ...rest } = raw;
      void _s;
      void _r;
      return { ...rest, phase: 'idle' };
    });
    store.set('tickets', migrated);
    store.set('schemaVersion', 4);
  }

  // v4 → v5: create default milestones per project, assign tickets
  if (version === 4 || (store.get('schemaVersion', 0) as number) === 4) {
    const projects = (store.get('projects', []) as Array<{ id: string }>) ?? [];
    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];

    const milestones: Milestone[] = [];
    const projectToDefaultMilestone = new Map<string, string>();

    for (const proj of projects) {
      const msId = deps.newId();
      projectToDefaultMilestone.set(proj.id, msId);
      const now = deps.now();
      milestones.push({
        id: msId,
        projectId: proj.id,
        title: 'General',
        description: 'Default milestone',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      } as Milestone);
    }

    const migratedTickets = tickets.map((raw) => ({
      ...raw,
      milestoneId: projectToDefaultMilestone.get(raw.projectId as string) ?? '',
    }));

    store.set('milestones', milestones);
    store.set('tickets', migratedTickets);
    store.set('schemaVersion', 5);
  }

  // v5 → v6: migrate inbox 'deferred' → 'iceboxed', add wipLimit
  if (version === 5 || (store.get('schemaVersion', 0) as number) === 5) {
    const inboxItems = (store.get('inboxItems', []) as Record<string, unknown>[]) ?? [];
    const migratedInbox = inboxItems.map((item) => ({
      ...item,
      status: (item.status as string) === 'deferred' ? 'iceboxed' : item.status,
    }));
    store.set('inboxItems', migratedInbox);
    if (store.get('wipLimit') === undefined) {
      store.set('wipLimit', 3);
    }
    store.set('schemaVersion', 6);
  }

  // v6 → v7: migrate Project.workspaceDir → Project.source
  if (version === 6 || (store.get('schemaVersion', 0) as number) === 6) {
    const projects = (store.get('projects', []) as Record<string, unknown>[]) ?? [];
    const migrated = projects.map((raw) => {
      if (raw.source && typeof raw.source === 'object') {
        return raw;
      }
      const { workspaceDir, ...rest } = raw;
      return {
        ...rest,
        source: { kind: 'local', workspaceDir: workspaceDir as string },
      };
    });
    store.set('projects', migrated);
    store.set('schemaVersion', 7);
  }

  // v7 → v8: rename initiatives → milestones, strip isDefault,
  //          rename ticket.initiativeId → milestoneId
  if (version === 7 || (store.get('schemaVersion', 0) as number) === 7) {
    const legacyInitiatives = (store.get('initiatives', []) as Record<string, unknown>[]) ?? [];
    const existingMilestones = (store.get('milestones', []) as Record<string, unknown>[]) ?? [];
    const rawItems = legacyInitiatives.length > 0 ? legacyInitiatives : existingMilestones;
    const milestones = rawItems.map((raw) => {
      const { isDefault: _d, ...rest } = raw;
      void _d;
      return rest;
    });
    if (legacyInitiatives.length > 0) {
      store.delete('initiatives');
    }
    store.set('milestones', milestones);

    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
    const migratedTickets = tickets.map((raw) => {
      const { initiativeId, ...rest } = raw;
      if (initiativeId !== undefined && !('milestoneId' in raw)) {
        return { ...rest, milestoneId: initiativeId };
      }
      return raw;
    });
    store.set('tickets', migratedTickets);

    const inboxItems = (store.get('inboxItems', []) as Record<string, unknown>[]) ?? [];
    const migratedInbox = inboxItems.map((raw) => {
      const { linkedInitiativeId, ...rest } = raw;
      return linkedInitiativeId ? { ...rest, linkedMilestoneId: linkedInitiativeId } : rest;
    });
    store.set('inboxItems', migratedInbox);

    store.set('schemaVersion', 8);
  }

  // v8 → v9: add slug to projects
  if (version === 8 || (store.get('schemaVersion', 0) as number) === 8) {
    const projects = (store.get('projects', []) as Record<string, unknown>[]) ?? [];
    const migrated = projects.map((raw) => {
      if (raw.slug) {
        return raw;
      }
      const label = (raw.label as string) ?? 'project';
      const slug =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'project';
      return { ...raw, slug };
    });
    store.set('projects', migrated);
    store.set('schemaVersion', 9);
  }

  // v9 → v10: add pages collection, seed root page per project,
  //           backfill project.brief → <projectDir>/context.md (fs side-effect)
  if (version === 9 || (store.get('schemaVersion', 0) as number) === 9) {
    const projects =
      (store.get('projects', []) as Array<{
        id: string;
        label: string;
        slug?: string;
        isPersonal?: boolean;
        brief?: string;
      }>) ?? [];
    const now = deps.now();
    const pages = projects.map((project) => ({
      id: deps.newId(),
      projectId: project.id,
      parentId: null,
      title: project.label,
      sortOrder: 0,
      isRoot: true,
      createdAt: now,
      updatedAt: now,
    }));
    store.set('pages', pages);

    if (deps.writeProjectContextBrief) {
      for (const project of projects) {
        try {
          deps.writeProjectContextBrief(project);
        } catch {
          /* non-critical */
        }
      }
    }

    store.set('schemaVersion', 10);
  }

  // v10 → v11: strip legacy `brief` field from project records
  if (version === 10 || (store.get('schemaVersion', 0) as number) === 10) {
    const projects = (store.get('projects', []) as Record<string, unknown>[]) ?? [];
    const cleaned = projects.map((raw) => {
      if ('brief' in raw) {
        const { brief: _brief, ...rest } = raw;
        void _brief;
        return rest;
      }
      return raw;
    });
    store.set('projects', cleaned);
    store.set('schemaVersion', 11);
  }

  // v11 → v13: upgrade legacy inbox records, ensure a Personal project exists
  if (version === 11 || (store.get('schemaVersion', 0) as number) === 11) {
    const projects =
      (store.get('projects', []) as Array<{
        id: string;
        label: string;
        isPersonal?: boolean;
        slug?: string;
      }>) ?? [];
    const legacyItems = (store.get('inboxItems', []) as Array<Record<string, unknown>>) ?? [];
    const now = deps.now();

    let personal = projects.find((p) => p.isPersonal);
    if (!personal) {
      personal = {
        id: deps.newId(),
        label: 'Personal',
        slug: 'personal',
        isPersonal: true,
      };
      (personal as unknown as { createdAt: number }).createdAt = now;
      projects.push(personal);
      store.set('projects', projects);
      deps.ensurePersonalProjectDir?.();
    }

    const upgraded = upgradeLegacyInbox(legacyItems, now, deps.newId);
    store.set('inboxItems', upgraded);
    store.set('schemaVersion', 13);
  }

  // v13 → v14: recover orphaned inbox data from pages[].properties
  if (version === 13 || (store.get('schemaVersion', 0) as number) === 13) {
    const pagesRaw = (store.get('pages', []) as Array<Record<string, unknown>>) ?? [];
    const existingInbox = ((store.get('inboxItems') ?? []) as InboxItem[]) ?? [];
    const recovered: InboxItem[] = [];
    const keptPages: Array<Record<string, unknown>> = [];
    /** True when we stripped at least one `properties` key (even an empty one). */
    let strippedAny = false;
    const now = deps.now();

    for (const pageRaw of pagesRaw) {
      const props = pageRaw.properties as Record<string, unknown> | undefined;
      if (!props || Object.keys(props).length === 0) {
        if ('properties' in pageRaw) {
          strippedAny = true;
        }
        const { properties: _p, ...rest } = pageRaw;
        void _p;
        keptPages.push(rest);
        continue;
      }

      const legacyStatus = props.status;
      if (legacyStatus === 'done') {
        continue;
      }

      const hasOutcome = typeof props.outcome === 'string' && (props.outcome as string).trim().length > 0;
      const hasShaping = hasOutcome || props.size !== undefined || typeof props.notDoing === 'string';
      let status: InboxItem['status'] = 'new';
      if (legacyStatus === 'later') {
        status = 'later';
      } else if (legacyStatus === 'ready' || legacyStatus === 'doing' || hasShaping) {
        status = 'shaped';
      }

      const appetite: InboxShaping['appetite'] =
        props.size === 'small' || props.size === 'medium' || props.size === 'large' || props.size === 'xl'
          ? (props.size as InboxShaping['appetite'])
          : 'medium';
      const shaping: InboxShaping | undefined = hasShaping
        ? {
            outcome: (props.outcome as string | undefined)?.trim() ?? '',
            appetite,
            ...(typeof props.notDoing === 'string' && (props.notDoing as string).trim()
              ? { notDoing: (props.notDoing as string).trim() }
              : {}),
          }
        : undefined;

      const item: InboxItem = {
        id: (pageRaw.id as string) ?? deps.newId(),
        title: (pageRaw.title as string | undefined)?.trim() || 'Untitled',
        status,
        projectId: typeof props.projectId === 'string' ? (props.projectId as string) : null,
        createdAt: typeof pageRaw.createdAt === 'number' ? (pageRaw.createdAt as number) : now,
        updatedAt: typeof pageRaw.updatedAt === 'number' ? (pageRaw.updatedAt as number) : now,
      };
      if (shaping) {
        item.shaping = shaping;
      }
      if (status === 'later') {
        item.laterAt = typeof props.laterAt === 'number' ? (props.laterAt as number) : now;
      }
      recovered.push(item);
    }

    if (recovered.length > 0 || keptPages.length !== pagesRaw.length || strippedAny) {
      if (recovered.length > 0) {
        store.set('inboxItems', [...existingInbox, ...recovered]);
      }
      store.set('pages', keptPages);
    }
    store.set('schemaVersion', 14);
  }

  // v14 → v15: backfill activity timestamps for dashboard ranking
  if (version === 14 || (store.get('schemaVersion', 0) as number) === 14) {
    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
    const migratedTickets = tickets.map((raw) => {
      const updatedAt = typeof raw.updatedAt === 'number' ? (raw.updatedAt as number) : deps.now();
      const next: Record<string, unknown> = { ...raw };
      if (next.phaseChangedAt === undefined) {
        next.phaseChangedAt = updatedAt;
      }
      if (next.columnChangedAt === undefined) {
        next.columnChangedAt = updatedAt;
      }
      if (raw.resolution !== undefined && next.resolvedAt === undefined) {
        next.resolvedAt = updatedAt;
      }
      return next;
    });
    store.set('tickets', migratedTickets);

    const milestones = (store.get('milestones', []) as Record<string, unknown>[]) ?? [];
    const migratedMilestones = milestones.map((raw) => {
      if (raw.status === 'completed' && raw.completedAt === undefined) {
        const updatedAt = typeof raw.updatedAt === 'number' ? (raw.updatedAt as number) : deps.now();
        return { ...raw, completedAt: updatedAt };
      }
      return raw;
    });
    store.set('milestones', migratedMilestones);

    if ((store.get('layoutMode') as string) === 'home') {
      store.set('layoutMode', 'chat');
    }

    store.set('schemaVersion', 15);
    deps.repairProjectRoots?.();
    // Fall through to v15→v16.
  }

  // v15 → v16: add ticket archive support (archivedAt field).
  if (version === 15 || (store.get('schemaVersion', 0) as number) === 15) {
    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
    const migratedTickets = tickets.map((raw) => {
      if ('archivedAt' in raw) {
        return raw;
      }
      return { ...raw, archivedAt: undefined };
    });
    store.set('tickets', migratedTickets);
    store.set('schemaVersion', 16);
    deps.repairProjectRoots?.();
    // Fall through to v16→v17.
  }

  // v16 → v17: add customApps (trivial — default is [])
  if (version === 16 || (store.get('schemaVersion', 0) as number) === 16) {
    store.set('schemaVersion', 17);
    deps.repairProjectRoots?.();
    // Fall through to v17→v18.
  }

  // v17 → v18: drop ticket.supervisorSessionId. The Code column owns the
  // session id now; any persisted value is stale and must not feed back into
  // newly mounted columns.
  if (version === 17 || (store.get('schemaVersion', 0) as number) === 17) {
    const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
    const migrated = tickets.map((raw) => {
      if (!('supervisorSessionId' in raw)) {
        return raw;
      }
      const { supervisorSessionId: _s, ...rest } = raw;
      void _s;
      return rest;
    });
    store.set('tickets', migrated);
    store.set('schemaVersion', 18);
    deps.repairProjectRoots?.();
    return;
  }

  if (((store.get('schemaVersion', 0) as number) ?? 0) >= 18) {
    deps.repairProjectRoots?.();
    return;
  }

  // Initial v0/v1/v2 → v3 boot: strip legacy phase/loop fields on tickets,
  // normalize to the minimal shape, then re-enter to run v3→v4+.
  const tickets = (store.get('tickets', []) as Record<string, unknown>[]) ?? [];
  const migrated: Record<string, unknown>[] = [];
  for (const raw of tickets) {
    const ticket: Record<string, unknown> = {
      id: (raw.id as string) ?? deps.newId(),
      projectId: (raw.projectId as string) ?? '',
      title: (raw.title as string) ?? '',
      description: (raw.description as string) ?? '',
      priority: (raw.priority as TicketPriority) ?? 'medium',
      blockedBy: (raw.blockedBy as TicketId[]) ?? [],
      createdAt: (raw.createdAt as number) ?? deps.now(),
      updatedAt: (raw.updatedAt as number) ?? deps.now(),
      columnId: (raw.columnId as ColumnId) ?? 'backlog',
    };
    if (!ticket.columnId) {
      const status = raw.status as string;
      if (status === 'in_progress') {
        ticket.columnId = 'implementation';
      } else if (status === 'completed' || status === 'closed') {
        ticket.columnId = 'completed';
      }
    }
    migrated.push(ticket);
  }
  store.set('tickets', migrated);
  store.set('schemaVersion', 4);
  // Re-enter to run v4→v5+ migrations.
  runMigrations(store, deps);
}

export { DEFAULT_BRIEF_TEMPLATE };
