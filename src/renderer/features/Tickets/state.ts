import { objectEquals } from '@observ33r/object-equals';
import { atom, computed, map } from 'nanostores';

import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { projectsApi } from '@/renderer/features/Projects/state';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { isActivePhase } from '@/shared/ticket-phase';
import { initiativeApi } from '@/renderer/features/Initiatives/state';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  ColumnId,
  DiffResponse,
  InitiativeId,
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
 * All tickets for the current project, keyed by ticket ID.
 */
export const $tickets = map<Record<TicketId, Ticket>>({});

/**
 * Cached pipeline for the current project.
 */
export const $pipeline = atom<Pipeline | null>(null);

/**
 * Which initiative is selected for kanban filtering. 'all' shows all initiatives.
 */
export const $activeInitiativeId = atom<InitiativeId | 'all'>('all');

/**
 * Which tickets view is active: dashboard = no selection, project = project detail, inbox = inbox view.
 * Ticket selection is handled by `activeTicketId` in the persisted store.
 */
export const $ticketsView = atom<
  { type: 'dashboard' } | { type: 'project'; projectId: ProjectId } | { type: 'inbox'; selectedItemId?: string }
>({ type: 'dashboard' });

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
      .filter((t) => t.ticketId && (t.status.type === 'running' || t.status.type === 'connecting' || t.status.type === 'starting'))
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

export const ticketApi = {
  // Projects (delegated to shared Projects module)
  addProject: projectsApi.addProject,
  updateProject: projectsApi.updateProject,
  removeProject: projectsApi.removeProject,

  // Git (delegated to shared Projects module)
  checkGitRepo: projectsApi.checkGitRepo,

  // Tickets
  addTicket: async (
    ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId' | 'initiativeId'> & { initiativeId?: InitiativeId }
  ): Promise<Ticket> => {
    const created = await emitter.invoke('project:add-ticket', ticket);
    $tickets.setKey(created.id, created);
    return created;
  },
  updateTicket: async (
    id: TicketId,
    patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>
  ): Promise<void> => {
    await emitter.invoke('project:update-ticket', id, patch);
    const existing = $tickets.get()[id];
    if (existing) {
      $tickets.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
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
    const newMap: Record<TicketId, Ticket> = {};
    for (const ticket of tickets) {
      newMap[ticket.id] = ticket;
    }
    $tickets.set(newMap);
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
  startSupervisor: (ticketId: TicketId): Promise<void> => {
    // Clear old messages when starting a fresh supervisor session
    $supervisorMessages.setKey(ticketId, []);
    return emitter.invoke('project:start-supervisor', ticketId);
  },
  stopSupervisor: (ticketId: TicketId): Promise<void> => {
    return emitter.invoke('project:stop-supervisor', ticketId);
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

  // Session history
  getSessionHistory: (sessionId: string): Promise<SessionMessage[]> => {
    return emitter.invoke('project:get-session-history', sessionId);
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
  getFilesChanged: (ticketId: TicketId): Promise<DiffResponse> => {
    return emitter.invoke('project:get-files-changed', ticketId);
  },

  // Navigation
  goToDashboard: (): void => {
    $ticketsView.set({ type: 'dashboard' });
  },
  goToInbox: (selectedItemId?: string): void => {
    $ticketsView.set({ type: 'inbox', selectedItemId });
  },
  goToProject: (projectId: ProjectId): void => {
    $ticketsView.set({ type: 'project', projectId });
    $activeInitiativeId.set('all');
    void ticketApi.fetchTickets(projectId);
    void ticketApi.getPipeline(projectId);
    void initiativeApi.fetchInitiatives(projectId);
  },
  setActiveTicket: (ticketId: TicketId): void => {
    persistedStoreApi.setKey('activeTicketId', ticketId);
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

  ipc.on('project:pipeline', (_projectId, pipeline: Pipeline) => {
    $pipeline.set(pipeline);
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
    if (view.type === 'project' && view.projectId) {
      projectIds.add(view.projectId);
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
