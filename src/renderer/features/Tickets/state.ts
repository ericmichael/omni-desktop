import { objectEquals } from '@observ33r/object-equals';
import { atom, computed, map } from 'nanostores';

import { groupTasks } from '@/lib/task-attention';
import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { milestoneApi } from '@/renderer/features/Initiatives/state';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { projectsApi } from '@/renderer/features/Projects/state';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  ColumnId,
  MilestoneId,
  PageId,
  Pipeline,
  ProjectId,
  SessionMessage,
  Task,
  TaskId,
  Ticket,
  TicketId,
  TicketPhase,
  TokenUsage,
} from '@/shared/types';

/**
 * All active tasks, keyed by task ID. Ephemeral — not persisted.
 */
export const $tasks = map<Record<TaskId, Task>>({});

/**
 * Tickets keyed by ID. Accumulates across projects — the sidebar tree and
 * the dashboard both need to render multiple projects' tickets at once.
 *
 * Hydrated from `store.tickets` on every `store:changed` broadcast so the
 * kanban view doesn't need a per-project `fetchTickets` round-trip to
 * render on initial boot. `fetchTickets` and per-row optimistic updates
 * still work — the main process re-broadcasts after every write, so any
 * optimistic state converges with the snapshot on the next tick.
 */
export const $tickets = map<Record<TicketId, Ticket>>({});

persistedStoreApi.$atom.subscribe((store) => {
  const next: Record<TicketId, Ticket> = {};
  for (const ticket of store.tickets) {
    next[ticket.id] = ticket;
  }
  // Only set when the shape actually changed — `subscribe` fires on every
  // store snapshot (theme toggles, sandbox state, etc.) but most won't
  // touch tickets. Skipping the write avoids spurious re-renders.
  if (!objectEquals($tickets.get(), next)) {
    $tickets.set(next);
  }
});

/**
 * Cached pipeline for the current project.
 */
export const $pipeline = atom<Pipeline | null>(null);

/**
 * Which milestone is selected for kanban filtering. 'all' shows all milestones.
 */
export const $activeMilestoneId = atom<MilestoneId | 'all'>('all');

/**
 * Board assignee filter (teams). `'all'` = everyone, `'me'` = assigned to the
 * current principal, `'unassigned'` = no assignee, or a specific member's
 * principal id. Always `'all'` effectively in single-user mode.
 */
export const $assigneeFilter = atom<'all' | 'me' | 'unassigned' | string>('all');

/**
 * Tabs of the project shell. Every project-scoped surface hangs off one of
 * these; detail views (page / milestone / ticket) are separate view types
 * that render inside the shell with the matching tab highlighted.
 */
export type ProjectTab = 'home' | 'board' | 'pages' | 'settings';

/**
 * Which Work-tab view is active: the global all-work list, the project shell
 * (with tab), or a project-scoped detail view. Home and Inbox are separate
 * rail tabs with their own state — they are not Work views.
 */
export type TicketsView =
  | { type: 'all' }
  | { type: 'inbox' }
  | { type: 'project'; projectId: ProjectId; tab: ProjectTab }
  | { type: 'ticket'; ticketId: TicketId }
  | { type: 'page'; pageId: PageId; projectId: ProjectId }
  | { type: 'milestone'; milestoneId: MilestoneId; projectId: ProjectId };

export const $ticketsView = atom<TicketsView>({ type: 'all' });

/** Build a unique nav value from the current view state, for sidebar
 *  selection painting. Every project-scoped view (any tab, page, milestone,
 *  ticket) selects its project's row. */
export function viewToNavValue(view: TicketsView, tickets: Record<string, Ticket>): string | undefined {
  if (view.type === 'all') {
    return 'all-work';
  }
  if (view.type === 'inbox') {
    return 'inbox';
  }
  if (view.type === 'project' || view.type === 'page' || view.type === 'milestone') {
    return `project:${view.projectId}`;
  }
  if (view.type === 'ticket') {
    const projectId = tickets[view.ticketId]?.projectId;
    return projectId ? `project:${projectId}` : undefined;
  }
  return undefined;
}

/**
 * Per-project "Needs you" counts for the sidebar badges — non-archived
 * tickets whose derived attention demands a human. Unfiltered on purpose
 * (the badges are global; WorkAllView applies its own filters).
 */
export const $needsYouByProject = computed(persistedStoreApi.$atom, (store) => {
  const pipelines = new Map<ProjectId, Pipeline>(store.projects.map((p) => [p.id, p.pipeline ?? DEFAULT_PIPELINE]));
  const active = store.tickets.filter((t) => !t.archivedAt);
  const counts: Record<ProjectId, number> = {};
  for (const { ticket } of groupTasks(active, (projectId) => pipelines.get(projectId)).needsYou) {
    counts[ticket.projectId] = (counts[ticket.projectId] ?? 0) + 1;
  }
  return counts;
});

/** Cross-project total, for the Tasks row's badge. */
export const $needsYouCount = computed($needsYouByProject, (counts) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0)
);

/** The project a view is scoped to, or null for the global all-work view.
 *  Ticket views don't carry a projectId — callers resolve it from the ticket. */
export function viewProjectId(view: TicketsView): ProjectId | null {
  if (view.type === 'project' || view.type === 'page' || view.type === 'milestone') {
    return view.projectId;
  }
  return null;
}

/**
 * Navigation history — a real stack, not a single slot, so task → task →
 * back works. Every forward navigation pushes the outgoing view; back pops.
 * Bounded so a long session can't grow it unboundedly.
 */
const MAX_HISTORY = 50;
export const $ticketsHistory = atom<TicketsView[]>([]);

const pushHistory = (view: TicketsView): void => {
  const stack = $ticketsHistory.get();
  $ticketsHistory.set([...stack.slice(-(MAX_HISTORY - 1)), view]);
};

/**
 * Make `view` current: run its data fetches and set the atom. Shared by
 * forward navigation (which pushes history first) and back (which pops).
 * Also raises the Work rail tab, so cross-tab jumps (Home card → task) need
 * no extra wiring at the call site.
 */
const applyTicketsView = (view: TicketsView): void => {
  if (persistedStoreApi.$atom.get().layoutMode !== 'work') {
    persistedStoreApi.setKey('layoutMode', 'work');
  }
  $ticketsView.set(view);
  switch (view.type) {
    case 'project':
      $activeMilestoneId.set('all');
      void ticketApi.fetchTickets(view.projectId);
      void ticketApi.getPipeline(view.projectId);
      void milestoneApi.fetchMilestones(view.projectId);
      void pageApi.fetchPages(view.projectId);
      break;
    case 'page':
      void pageApi.fetchPages(view.projectId);
      break;
    case 'milestone':
      void ticketApi.fetchTickets(view.projectId);
      void milestoneApi.fetchMilestones(view.projectId);
      break;
    case 'ticket': {
      persistedStoreApi.setKey('activeTicketId', view.ticketId);
      // Hydrate `$tickets` so TicketDetail can find the ticket even when
      // entering from a path that didn't run fetchTickets (e.g. Home click).
      // Use the broadcast snapshot for the synchronous initial render, then
      // refresh from the source of truth.
      const inMemory = $tickets.get()[view.ticketId];
      if (!inMemory) {
        const persisted = persistedStoreApi.$atom.get().tickets.find((t) => t.id === view.ticketId);
        if (persisted) {
          $tickets.setKey(view.ticketId, persisted);
        }
      }
      const projectId = (
        $tickets.get()[view.ticketId] ?? persistedStoreApi.$atom.get().tickets.find((t) => t.id === view.ticketId)
      )?.projectId;
      if (projectId) {
        void ticketApi.fetchTickets(projectId);
      }
      break;
    }
    case 'all':
    case 'inbox':
      // Inbox state is derived from the persisted store — nothing to fetch.
      break;
  }
};

const navigateTo = (view: TicketsView): void => {
  pushHistory($ticketsView.get());
  applyTicketsView(view);
};

/** For external navigation plumbing (app-history's popstate handler): record
 *  the view being left so in-app Back buttons stay coherent. */
export const pushTicketsHistory = pushHistory;

/**
 * Supervisor chat messages, keyed by ticket ID.
 */
export const $supervisorMessages = map<Record<TicketId, SessionMessage[]>>({});

export type ActiveTicketEntry = {
  ticket: Ticket;
  hasLiveTask: boolean;
};

/**
 * All tickets for the current project, sorted: live tasks first, then by updatedAt desc.
 */
export const $activeTickets = computed([$tickets, $tasks], (ticketMap, taskMap) => {
  const tasks = Object.values(taskMap);
  const liveTaskTicketIds = new Set(
    tasks
      .filter(
        (t) =>
          t.ticketId && (t.status.type === 'running' || t.status.type === 'connecting' || t.status.type === 'starting')
      )
      .map((t) => t.ticketId!)
  );

  const entries: ActiveTicketEntry[] = [];
  for (const ticket of Object.values(ticketMap)) {
    const phase = ticket.phase;
    const isActive = phase != null && isActivePhase(phase);
    entries.push({
      ticket,
      hasLiveTask: liveTaskTicketIds.has(ticket.id) || isActive,
    });
  }

  return entries.sort((a, b) => {
    if (a.hasLiveTask !== b.hasLiveTask) {
      return a.hasLiveTask ? -1 : 1;
    }
    return b.ticket.updatedAt - a.ticket.updatedAt;
  });
});

export const $autopilotLaunchTicketId = atom<TicketId | null>(null);

export const ticketApi = {
  // Projects (delegated to shared Projects module)
  addProject: projectsApi.addProject,
  updateProject: projectsApi.updateProject,
  removeProject: projectsApi.removeProject,

  /**
   * Single write path for renaming a project. The project label and its root
   * page title are the same user-visible name, so every rename surface
   * (shell header, root page title input) goes through here to keep both in
   * sync in one place.
   */
  renameProject: async (projectId: ProjectId, label: string): Promise<void> => {
    const trimmed = label.trim();
    if (!trimmed) {
      return;
    }
    await projectsApi.updateProject(projectId, { label: trimmed });
    const rootPage = Object.values($pages.get()).find((p) => p.projectId === projectId && p.isRoot);
    if (rootPage && rootPage.title !== trimmed) {
      await pageApi.updatePage(rootPage.id, { title: trimmed });
    }
  },

  // Git (delegated to shared Projects module)
  checkGitRepo: projectsApi.checkGitRepo,

  // Tickets
  addTicket: async (ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'>): Promise<Ticket> => {
    const created = await emitter.invoke('project:add-ticket', ticket);
    $tickets.setKey(created.id, created);
    return created;
  },
  updateTicket: async (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>): Promise<void> => {
    await emitter.invoke('project:update-ticket', id, patch);
    const existing = $tickets.get()[id];
    if (existing) {
      $tickets.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },
  archiveTicket: async (ticketId: TicketId): Promise<void> => {
    const archivedAt = Date.now();
    await emitter.invoke('project:update-ticket', ticketId, { archivedAt });
    const existing = $tickets.get()[ticketId];
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, archivedAt, updatedAt: Date.now() });
    }
  },
  unarchiveTicket: async (ticketId: TicketId): Promise<void> => {
    await emitter.invoke('project:update-ticket', ticketId, { archivedAt: undefined });
    const existing = $tickets.get()[ticketId];
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, archivedAt: undefined, updatedAt: Date.now() });
    }
  },
  moveTicketToMilestone: async (ticketId: TicketId, milestoneId: MilestoneId | undefined): Promise<void> => {
    await emitter.invoke('project:update-ticket', ticketId, { milestoneId });
    const existing = $tickets.get()[ticketId];
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, milestoneId, updatedAt: Date.now() });
    }
  },
  removeTicket: async (ticketId: TicketId): Promise<void> => {
    await emitter.invoke('project:remove-ticket', ticketId);
    const current = { ...$tickets.get() };
    delete current[ticketId];
    $tickets.set(current);
    // Clear active ticket if it was the one removed
    if (persistedStoreApi.$atom.get().activeTicketId === ticketId) {
      persistedStoreApi.setKey('activeTicketId', null);
    }
  },
  fetchTickets: async (projectId: ProjectId): Promise<void> => {
    const tickets = await emitter.invoke('project:get-tickets', projectId);
    // Merge: replace this project's tickets, keep others untouched so
    // expanding another project in the tree doesn't wipe this one.
    const current = $tickets.get();
    const next: Record<TicketId, Ticket> = {};
    for (const [id, ticket] of Object.entries(current)) {
      if (ticket.projectId !== projectId) {
        next[id] = ticket;
      }
    }
    for (const ticket of tickets) {
      next[ticket.id] = ticket;
    }
    $tickets.set(next);
  },
  getTicketWorkspace: (ticketId: TicketId): Promise<string> => {
    return emitter.invoke('project:get-ticket-workspace', ticketId);
  },
  fetchTasks: async (): Promise<void> => {
    const tasks = await emitter.invoke('project:get-tasks');
    const newMap: Record<TaskId, Task> = {};
    for (const task of tasks) {
      newMap[task.id] = task;
    }
    $tasks.set(newMap);
  },
  getNextTicket: (projectId: ProjectId): Promise<Ticket | null> => {
    return emitter.invoke('project:get-next-ticket', projectId);
  },

  // Pipeline
  getPipeline: async (projectId: ProjectId): Promise<Pipeline> => {
    const pipeline = await emitter.invoke('project:get-pipeline', projectId);
    $pipeline.set(pipeline);
    return pipeline;
  },
  moveTicketToColumn: (ticketId: TicketId, columnId: ColumnId): Promise<void> => {
    return emitter.invoke('project:move-ticket-to-column', ticketId, columnId);
  },
  /** Assign (principal id) or unassign (null) — team ownership is unchanged; any member may call. */
  assignTicket: async (ticketId: TicketId, assignee: string | null): Promise<void> => {
    await emitter.invoke('project:assign-ticket', ticketId, assignee);
    const existing = $tickets.get()[ticketId];
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, assignee: assignee || undefined, updatedAt: Date.now() });
    }
  },
  resolveTicket: async (ticketId: TicketId, resolution: import('@/shared/types').TicketResolution): Promise<void> => {
    await emitter.invoke('project:resolve-ticket', ticketId, resolution);
    const existing = $tickets.get()[ticketId];
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, resolution, updatedAt: Date.now() });
    }
  },
  // Supervisor
  ensureSupervisorInfra: async (ticketId: TicketId): Promise<void> => {
    await emitter.invoke('project:ensure-supervisor-infra', ticketId);
    // Re-fetch tickets + tasks so the renderer picks up supervisorTaskId and task status
    // immediately rather than waiting for the next poll interval.
    const ticket = $tickets.get()[ticketId];
    const projectId =
      ticket?.projectId ?? persistedStoreApi.$atom.get().tickets.find((t) => t.id === ticketId)?.projectId;
    if (projectId) {
      void ticketApi.fetchTickets(projectId);
    }
    void ticketApi.fetchTasks();
  },
  requestStartSupervisor: (ticketId: TicketId): void => {
    $autopilotLaunchTicketId.set(ticketId);
  },
  startSupervisor: async (ticketId: TicketId, opts?: { profileName?: string }): Promise<void> => {
    // Clear old messages when starting a fresh supervisor session
    $supervisorMessages.setKey(ticketId, []);
    await emitter.invoke('project:start-supervisor', ticketId, opts?.profileName);
  },
  stopSupervisor: (ticketId: TicketId): Promise<void> => {
    return emitter.invoke('project:stop-supervisor', ticketId);
  },
  finalizeTicketCleanup: async (ticketId: TicketId): Promise<boolean> => {
    const ok = await emitter.invoke('project:finalize-ticket-cleanup', ticketId);
    void ticketApi.fetchTasks();
    return ok;
  },
  sendSupervisorMessage: (ticketId: TicketId, message: string): Promise<void> => {
    // Optimistically add the user's message to the chat so it appears immediately
    const userMsg: SessionMessage = {
      id: Date.now(),
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    };
    const existing = $supervisorMessages.get()[ticketId] ?? [];
    $supervisorMessages.setKey(ticketId, [...existing, userMsg]);

    return emitter.invoke('project:send-supervisor-message', ticketId, message);
  },
  resetSupervisorSession: (ticketId: TicketId): Promise<void> => {
    $supervisorMessages.setKey(ticketId, []);
    return emitter.invoke('project:reset-supervisor-session', ticketId);
  },
  setAutoDispatch: (projectId: ProjectId, enabled: boolean): Promise<void> => {
    return emitter.invoke('project:set-auto-dispatch', projectId, enabled);
  },
  // Artifacts
  listArtifacts: (ticketId: TicketId, dirPath?: string): Promise<ArtifactFileEntry[]> => {
    return emitter.invoke('project:list-artifacts', ticketId, dirPath);
  },
  readArtifact: (ticketId: TicketId, relativePath: string): Promise<ArtifactFileContent> => {
    return emitter.invoke('project:read-artifact', ticketId, relativePath);
  },
  openArtifactExternal: (ticketId: TicketId, relativePath: string): Promise<void> => {
    return emitter.invoke('project:open-artifact-external', ticketId, relativePath);
  },

  // Context files (replaces project.brief)
  readContext: (projectId: ProjectId): Promise<string> => {
    return emitter.invoke('project:read-context', projectId);
  },
  writeContext: (projectId: ProjectId, content: string): Promise<void> => {
    return emitter.invoke('project:write-context', projectId, content);
  },

  // Project files
  listProjectFiles: (projectId: ProjectId): Promise<ArtifactFileEntry[]> => {
    return emitter.invoke('project:list-project-files', projectId);
  },
  getContextPreview: (projectId: ProjectId): Promise<string> => {
    return emitter.invoke('project:get-context-preview', projectId);
  },
  openProjectFile: (projectId: ProjectId, relativePath: string): Promise<void> => {
    return emitter.invoke('project:open-project-file', projectId, relativePath);
  },

  // Navigation
  goToAllWork: (): void => {
    navigateTo({ type: 'all' });
  },
  goToInbox: (): void => {
    navigateTo({ type: 'inbox' });
  },
  goToProject: (projectId: ProjectId, tab: ProjectTab = 'home'): void => {
    navigateTo({ type: 'project', projectId, tab });
  },
  goToPage: (pageId: PageId, projectId: ProjectId): void => {
    navigateTo({ type: 'page', pageId, projectId });
  },
  goToMilestone: (milestoneId: MilestoneId, projectId: ProjectId): void => {
    navigateTo({ type: 'milestone', milestoneId, projectId });
  },
  /** Sugar for the shell's Work tab — keeps existing call sites terse. */
  goToBoard: (projectId: ProjectId): void => {
    ticketApi.goToProject(projectId, 'board');
  },
  goToTicket: (ticketId: TicketId): void => {
    navigateTo({ type: 'ticket', ticketId });
  },
  setActiveTicket: (ticketId: TicketId): void => {
    persistedStoreApi.setKey('activeTicketId', ticketId);
  },
  goBackToPrevious: (fallbackProjectId?: ProjectId): void => {
    const stack = $ticketsHistory.get();
    const previous = stack[stack.length - 1];
    if (previous) {
      $ticketsHistory.set(stack.slice(0, -1));
      applyTicketsView(previous);
      return;
    }
    applyTicketsView(
      fallbackProjectId ? { type: 'project', projectId: fallbackProjectId, tab: 'home' } : { type: 'all' }
    );
  },
};

const listen = () => {
  ipc.on('project:task-status', (taskId, status) => {
    const existing = $tasks.get()[taskId];
    if (existing) {
      $tasks.setKey(taskId, { ...existing, status });
    } else {
      // Task was created on main process but renderer doesn't have it yet — bootstrap a minimal entry
      // so the UI can track its status (e.g. show the webview once the sandbox is running).
      $tasks.setKey(taskId, {
        id: taskId,
        projectId: '',
        taskDescription: '',
        status,
        createdAt: Date.now(),
      });
    }
  });

  ipc.on('project:task-session', (taskId, sessionId) => {
    const existing = $tasks.get()[taskId];
    if (existing) {
      $tasks.setKey(taskId, { ...existing, sessionId });
    }
  });

  ipc.on('project:phase', (ticketId, phase: TicketPhase) => {
    let existing = $tickets.get()[ticketId];
    if (!existing) {
      // Ticket not yet in the in-memory map — bootstrap from persisted store
      const persisted = persistedStoreApi.$atom.get().tickets.find((t) => t.id === ticketId);
      if (persisted) {
        existing = persisted;
      }
    }
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, phase });
    }
  });

  ipc.on('project:supervisor-message', (ticketId, message: SessionMessage) => {
    const existing = $supervisorMessages.get()[ticketId] ?? [];
    $supervisorMessages.setKey(ticketId, [...existing, message]);
  });

  ipc.on('project:token-usage', (ticketId, usage: TokenUsage) => {
    let existing = $tickets.get()[ticketId];
    if (!existing) {
      const persisted = persistedStoreApi.$atom.get().tickets.find((t) => t.id === ticketId);
      if (persisted) {
        existing = persisted;
      }
    }
    if (existing) {
      $tickets.setKey(ticketId, { ...existing, tokenUsage: usage });
    }
  });

  // Hydrate tasks on init so the renderer has current task state immediately
  void ticketApi.fetchTasks();

  const poll = async () => {
    // Re-fetch tasks so the renderer stays in sync with the main process
    void ticketApi.fetchTasks();

    // Collect project IDs that need ticket refreshes:
    // 1. The current project view in the Projects tab
    const projectIds = new Set<ProjectId>();
    const view = $ticketsView.get();
    const viewProject = viewProjectId(view);
    if (viewProject) {
      projectIds.add(viewProject);
    }

    // 2. Any projects with ticket-linked Code tabs open
    const codeTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    for (const tab of codeTabs) {
      if (tab.ticketId && tab.projectId) {
        projectIds.add(tab.projectId);
      }
    }

    // Fetch tickets for all relevant projects and merge into the map
    const currentMap = { ...$tickets.get() };
    let changed = false;
    for (const projectId of projectIds) {
      const tickets = await emitter.invoke('project:get-tickets', projectId);
      for (const ticket of tickets) {
        if (!objectEquals(currentMap[ticket.id], ticket)) {
          currentMap[ticket.id] = ticket;
          changed = true;
        }
      }
    }
    if (changed) {
      $tickets.set(currentMap);
    }
  };

  setInterval(poll, STATUS_POLL_INTERVAL_MS);
};

listen();
