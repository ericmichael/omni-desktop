import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { atom, computed, map } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  FleetChecklistItem,
  FleetColumnId,
  FleetPhase,
  FleetPipeline,
  FleetProject,
  FleetProjectId,
  FleetSessionMessage,
  FleetTask,
  FleetTaskId,
  FleetTaskSubmitOptions,
  FleetTicket,
  FleetTicketId,
  FleetTicketLoopUpdate,
  GitRepoInfo,
} from '@/shared/types';

/**
 * All active fleet tasks, keyed by task ID. Ephemeral — not persisted.
 */
export const $fleetTasks = map<Record<FleetTaskId, FleetTask>>({});

/**
 * All fleet tickets for the current project, keyed by ticket ID.
 */
export const $fleetTickets = map<Record<FleetTicketId, FleetTicket>>({});

/**
 * Cached pipeline for the current project.
 */
export const $fleetPipeline = atom<FleetPipeline | null>(null);

/**
 * Which fleet view is active: dashboard = no selection, project = project detail, task = task sandbox view, ticket = ticket detail.
 */
export const $fleetView = atom<
  | { type: 'dashboard' }
  | { type: 'project'; projectId: FleetProjectId }
  | { type: 'task'; taskId: FleetTaskId }
  | { type: 'ticket'; ticketId: FleetTicketId }
>({ type: 'dashboard' });

/**
 * Per-task xterm instances for log output.
 */
export const $fleetTaskXTerms = map<Record<FleetTaskId, Terminal>>({});

export type ActiveTicketEntry = {
  ticket: FleetTicket;
  hasLiveTask: boolean;
  currentPhase: FleetPhase | undefined;
};

const ACTIVE_COLUMNS = new Set(['spec', 'implementation', 'review', 'pr']);

/**
 * Active tickets for the current project: not in backlog, not completed.
 * Sorted: tickets with live tasks first, then by updatedAt desc.
 */
export const $activeTickets = computed([$fleetTickets, $fleetTasks], (ticketMap, taskMap) => {
  const tasks = Object.values(taskMap);
  const liveTaskTicketIds = new Set(
    tasks
      .filter((t) => t.ticketId && (t.status.type === 'running' || t.status.type === 'starting'))
      .map((t) => t.ticketId!)
  );

  const entries: ActiveTicketEntry[] = [];
  for (const ticket of Object.values(ticketMap)) {
    if (!ticket.columnId || !ACTIVE_COLUMNS.has(ticket.columnId)) {
      continue;
    }
    const currentPhase = ticket.currentPhaseId ? ticket.phases.find((p) => p.id === ticket.currentPhaseId) : undefined;
    entries.push({
      ticket,
      hasLiveTask: liveTaskTicketIds.has(ticket.id),
      currentPhase,
    });
  }

  return entries.sort((a, b) => {
    if (a.hasLiveTask !== b.hasLiveTask) {
      return a.hasLiveTask ? -1 : 1;
    }
    return b.ticket.updatedAt - a.ticket.updatedAt;
  });
});

const initializeTaskTerminal = (id: FleetTaskId): Terminal => {
  const existing = $fleetTaskXTerms.get()[id];
  if (existing) {
    return existing;
  }
  const xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });
  $fleetTaskXTerms.setKey(id, xterm);
  return xterm;
};

const teardownTaskTerminal = (id: FleetTaskId): void => {
  const xterm = $fleetTaskXTerms.get()[id];
  if (!xterm) {
    return;
  }
  xterm.dispose();
  const current = { ...$fleetTaskXTerms.get() };
  delete current[id];
  $fleetTaskXTerms.set(current);
};

export const fleetApi = {
  // Projects
  addProject: (project: Omit<FleetProject, 'id' | 'createdAt'>): Promise<FleetProject> => {
    return emitter.invoke('fleet:add-project', project);
  },
  updateProject: (id: FleetProjectId, patch: Partial<Omit<FleetProject, 'id' | 'createdAt'>>): Promise<void> => {
    return emitter.invoke('fleet:update-project', id, patch);
  },
  removeProject: (id: FleetProjectId): Promise<void> => {
    return emitter.invoke('fleet:remove-project', id);
  },

  // Git
  checkGitRepo: (workspaceDir: string): Promise<GitRepoInfo> => {
    return emitter.invoke('fleet:check-git-repo', workspaceDir);
  },

  // Tasks
  submitTask: async (
    projectId: FleetProjectId,
    taskDescription: string,
    options: FleetTaskSubmitOptions = {}
  ): Promise<FleetTask> => {
    const task = await emitter.invoke('fleet:submit-task', projectId, taskDescription, options);
    initializeTaskTerminal(task.id);
    $fleetTasks.setKey(task.id, task);
    return task;
  },
  stopTask: (taskId: FleetTaskId): Promise<void> => {
    return emitter.invoke('fleet:stop-task', taskId);
  },
  removeTask: async (taskId: FleetTaskId): Promise<void> => {
    await emitter.invoke('fleet:remove-task', taskId);
    teardownTaskTerminal(taskId);
    const current = { ...$fleetTasks.get() };
    delete current[taskId];
    $fleetTasks.set(current);
    // If viewing this task, go back
    const view = $fleetView.get();
    if (view.type === 'task' && view.taskId === taskId) {
      $fleetView.set({ type: 'dashboard' });
    }
  },

  // Tickets
  addTicket: async (
    ticket: Omit<
      FleetTicket,
      'id' | 'createdAt' | 'updatedAt' | 'status' | 'taskId' | 'columnId' | 'currentPhaseId' | 'phases' | 'checklist'
    >
  ): Promise<FleetTicket> => {
    const created = await emitter.invoke('fleet:add-ticket', ticket);
    $fleetTickets.setKey(created.id, created);
    return created;
  },
  updateTicket: async (
    id: FleetTicketId,
    patch: Partial<Omit<FleetTicket, 'id' | 'projectId' | 'createdAt'>>
  ): Promise<void> => {
    await emitter.invoke('fleet:update-ticket', id, patch);
    const existing = $fleetTickets.get()[id];
    if (existing) {
      $fleetTickets.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },
  removeTicket: async (ticketId: FleetTicketId): Promise<void> => {
    await emitter.invoke('fleet:remove-ticket', ticketId);
    const current = { ...$fleetTickets.get() };
    delete current[ticketId];
    $fleetTickets.set(current);
    const view = $fleetView.get();
    if (view.type === 'ticket' && view.ticketId === ticketId) {
      $fleetView.set({ type: 'dashboard' });
    }
  },
  fetchTickets: async (projectId: FleetProjectId): Promise<void> => {
    const tickets = await emitter.invoke('fleet:get-tickets', projectId);
    const newMap: Record<FleetTicketId, FleetTicket> = {};
    for (const ticket of tickets) {
      newMap[ticket.id] = ticket;
    }
    $fleetTickets.set(newMap);
  },
  getNextTicket: (projectId: FleetProjectId): Promise<FleetTicket | null> => {
    return emitter.invoke('fleet:get-next-ticket', projectId);
  },
  submitTicketTask: async (ticketId: FleetTicketId, options: FleetTaskSubmitOptions = {}): Promise<FleetTask> => {
    const task = await emitter.invoke('fleet:submit-ticket-task', ticketId, options);
    initializeTaskTerminal(task.id);
    $fleetTasks.setKey(task.id, task);
    // Update the ticket in local state
    const ticket = $fleetTickets.get()[ticketId];
    if (ticket) {
      const loopUpdate: Partial<FleetTicket> = { status: 'in_progress', taskId: task.id };
      if (options.loop) {
        loopUpdate.loopEnabled = true;
        loopUpdate.loopMaxIterations = options.loopMaxIterations ?? 10;
        loopUpdate.loopIteration = 1;
        loopUpdate.loopStatus = 'running';
      }
      $fleetTickets.setKey(ticketId, { ...ticket, ...loopUpdate });
    }
    return task;
  },
  stopLoop: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:stop-loop', ticketId);
  },
  resumeLoop: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:resume-loop', ticketId);
  },

  // Pipeline & phase operations
  getPipeline: async (projectId: FleetProjectId): Promise<FleetPipeline> => {
    const pipeline = await emitter.invoke('fleet:get-pipeline', projectId);
    $fleetPipeline.set(pipeline);
    return pipeline;
  },
  advanceTicket: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:advance-ticket', ticketId);
  },
  moveTicketToColumn: (ticketId: FleetTicketId, columnId: FleetColumnId): Promise<void> => {
    return emitter.invoke('fleet:move-ticket-to-column', ticketId, columnId);
  },
  kickbackTicket: (ticketId: FleetTicketId, targetColumnId: FleetColumnId, reviewNote?: string): Promise<void> => {
    return emitter.invoke('fleet:kickback-ticket', ticketId, targetColumnId, reviewNote);
  },
  approvePhase: (ticketId: FleetTicketId, reviewNote?: string): Promise<void> => {
    return emitter.invoke('fleet:approve-phase', ticketId, reviewNote);
  },
  rejectPhase: (ticketId: FleetTicketId, reviewNote: string): Promise<void> => {
    return emitter.invoke('fleet:reject-phase', ticketId, reviewNote);
  },
  startPhase: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:start-phase', ticketId);
  },
  stopPhase: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:stop-phase', ticketId);
  },
  resumePhase: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:resume-phase', ticketId);
  },
  updateChecklist: (
    ticketId: FleetTicketId,
    columnId: FleetColumnId,
    checklist: FleetChecklistItem[]
  ): Promise<void> => {
    return emitter.invoke('fleet:update-checklist', ticketId, columnId, checklist);
  },
  toggleChecklistItem: (ticketId: FleetTicketId, columnId: FleetColumnId, itemId: string): Promise<void> => {
    return emitter.invoke('fleet:toggle-checklist-item', ticketId, columnId, itemId);
  },

  submitPlanTask: async (ticketId: FleetTicketId): Promise<FleetTask> => {
    const task = await emitter.invoke('fleet:submit-plan-task', ticketId);
    initializeTaskTerminal(task.id);
    $fleetTasks.setKey(task.id, task);
    return task;
  },
  submitChatTask: async (ticketId: FleetTicketId): Promise<FleetTask> => {
    const task = await emitter.invoke('fleet:submit-chat-task', ticketId);
    initializeTaskTerminal(task.id);
    $fleetTasks.setKey(task.id, task);
    return task;
  },

  // Session history
  getSessionHistory: (sessionId: string): Promise<FleetSessionMessage[]> => {
    return emitter.invoke('fleet:get-session-history', sessionId);
  },

  // Artifacts
  listArtifacts: (ticketId: FleetTicketId, dirPath?: string): Promise<ArtifactFileEntry[]> => {
    return emitter.invoke('fleet:list-artifacts', ticketId, dirPath);
  },
  readArtifact: (ticketId: FleetTicketId, relativePath: string): Promise<ArtifactFileContent> => {
    return emitter.invoke('fleet:read-artifact', ticketId, relativePath);
  },
  openArtifactExternal: (ticketId: FleetTicketId, relativePath: string): Promise<void> => {
    return emitter.invoke('fleet:open-artifact-external', ticketId, relativePath);
  },

  // Navigation
  goToDashboard: (): void => {
    $fleetView.set({ type: 'dashboard' });
  },
  goToProject: (projectId: FleetProjectId): void => {
    $fleetView.set({ type: 'project', projectId });
    void fleetApi.fetchTickets(projectId);
    void fleetApi.getPipeline(projectId);
  },
  goToTask: (taskId: FleetTaskId): void => {
    $fleetView.set({ type: 'task', taskId });
  },
  goToTicket: (ticketId: FleetTicketId): void => {
    $fleetView.set({ type: 'ticket', ticketId });
  },
};

const listen = () => {
  // Eagerly fetch all tasks when we receive an event for an unknown task ID.
  // This happens for tasks created by phase loops which bypass submitTask/submitTicketTask.
  const fetchMissingTask = async (taskId: FleetTaskId) => {
    const tasks = await emitter.invoke('fleet:get-tasks');
    const newMap: Record<FleetTaskId, FleetTask> = {};
    for (const task of tasks) {
      newMap[task.id] = task;
    }
    if (!objectEquals($fleetTasks.get(), newMap)) {
      $fleetTasks.set(newMap);
    }
    return newMap[taskId];
  };

  ipc.on('fleet:task-status', (_, taskId, status) => {
    const existing = $fleetTasks.get()[taskId];
    if (existing) {
      $fleetTasks.setKey(taskId, { ...existing, status });
    } else {
      void fetchMissingTask(taskId);
    }
    if (status.type === 'exited') {
      teardownTaskTerminal(taskId);
    }
  });

  ipc.on('fleet:task-session', (_, taskId, sessionId) => {
    const existing = $fleetTasks.get()[taskId];
    if (existing) {
      $fleetTasks.setKey(taskId, { ...existing, sessionId });
    } else {
      void fetchMissingTask(taskId);
    }
  });

  ipc.on('fleet:task-raw-output', (_, taskId, data) => {
    const xterm = $fleetTaskXTerms.get()[taskId];
    xterm?.write(data);
  });

  ipc.on('fleet:phase-update', (_, ticketId, phase) => {
    const existing = $fleetTickets.get()[ticketId];
    if (existing) {
      const updatedPhases = existing.phases.map((p) => (p.id === phase.id ? phase : p));
      // If the phase is new (not found in existing phases), append it
      if (!existing.phases.some((p) => p.id === phase.id)) {
        updatedPhases.push(phase);
      }
      $fleetTickets.setKey(ticketId, {
        ...existing,
        phases: updatedPhases,
        currentPhaseId: phase.id,
      });
    }
  });

  ipc.on('fleet:ticket-loop-update', (_, ticketId, update: FleetTicketLoopUpdate) => {
    const existing = $fleetTickets.get()[ticketId];
    if (existing) {
      $fleetTickets.setKey(ticketId, {
        ...existing,
        loopIteration: update.iteration,
        loopMaxIterations: update.maxIterations,
        loopStatus: update.status,
      });
    }
  });

  const pollTasks = async () => {
    const tasks = await emitter.invoke('fleet:get-tasks');
    const newMap: Record<FleetTaskId, FleetTask> = {};
    for (const task of tasks) {
      newMap[task.id] = task;
    }
    if (!objectEquals($fleetTasks.get(), newMap)) {
      $fleetTasks.set(newMap);
    }
  };

  const pollTickets = async () => {
    // Re-fetch tickets for the current project view
    const view = $fleetView.get();
    if (view.type !== 'project' && view.type !== 'ticket') {
      return;
    }
    const projectId = view.type === 'project' ? view.projectId : $fleetTickets.get()[view.ticketId]?.projectId;
    if (!projectId) {
      return;
    }
    const tickets = await emitter.invoke('fleet:get-tickets', projectId);
    const newMap: Record<FleetTicketId, FleetTicket> = {};
    for (const ticket of tickets) {
      newMap[ticket.id] = ticket;
    }
    if (!objectEquals($fleetTickets.get(), newMap)) {
      $fleetTickets.set(newMap);
    }
  };

  setInterval(pollTasks, STATUS_POLL_INTERVAL_MS);
  setInterval(pollTickets, STATUS_POLL_INTERVAL_MS);
};

listen();
