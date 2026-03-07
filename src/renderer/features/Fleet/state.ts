import { objectEquals } from '@observ33r/object-equals';
import { atom, computed, map } from 'nanostores';

import { STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  DiffResponse,
  FleetColumnId,
  FleetPipeline,
  FleetProject,
  FleetProjectId,
  FleetSessionMessage,
  FleetTask,
  FleetTaskId,
  FleetTicket,
  FleetTicketId,
  FleetTokenUsage,
  GitRepoInfo,
  TicketPhase,
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
 * Which fleet view is active: dashboard = no selection, project = project detail, ticket = ticket detail.
 */
export const $fleetView = atom<
  { type: 'dashboard' } | { type: 'project'; projectId: FleetProjectId } | { type: 'ticket'; ticketId: FleetTicketId }
>({ type: 'dashboard' });

/**
 * Supervisor chat messages, keyed by ticket ID.
 */
export const $supervisorMessages = map<Record<FleetTicketId, FleetSessionMessage[]>>({});

export type ActiveTicketEntry = {
  ticket: FleetTicket;
  hasLiveTask: boolean;
};

/**
 * All tickets for the current project, sorted: live tasks first, then by updatedAt desc.
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
    const phase = ticket.phase;
    const isActive = phase != null && phase !== 'idle' && phase !== 'error' && phase !== 'completed';
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

  // Tickets
  addTicket: async (
    ticket: Omit<FleetTicket, 'id' | 'createdAt' | 'updatedAt' | 'columnId'>
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

  // Pipeline
  getPipeline: async (projectId: FleetProjectId): Promise<FleetPipeline> => {
    const pipeline = await emitter.invoke('fleet:get-pipeline', projectId);
    $fleetPipeline.set(pipeline);
    return pipeline;
  },
  moveTicketToColumn: (ticketId: FleetTicketId, columnId: FleetColumnId): Promise<void> => {
    return emitter.invoke('fleet:move-ticket-to-column', ticketId, columnId);
  },
  // Supervisor
  ensureSupervisorInfra: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:ensure-supervisor-infra', ticketId);
  },
  startSupervisor: (ticketId: FleetTicketId): Promise<void> => {
    // Clear old messages when starting a fresh supervisor session
    $supervisorMessages.setKey(ticketId, []);
    return emitter.invoke('fleet:start-supervisor', ticketId);
  },
  stopSupervisor: (ticketId: FleetTicketId): Promise<void> => {
    return emitter.invoke('fleet:stop-supervisor', ticketId);
  },
  sendSupervisorMessage: (ticketId: FleetTicketId, message: string): Promise<void> => {
    // Optimistically add the user's message to the chat so it appears immediately
    const userMsg: FleetSessionMessage = {
      id: Date.now(),
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    };
    const existing = $supervisorMessages.get()[ticketId] ?? [];
    $supervisorMessages.setKey(ticketId, [...existing, userMsg]);

    return emitter.invoke('fleet:send-supervisor-message', ticketId, message);
  },
  resetSupervisorSession: (ticketId: FleetTicketId): Promise<void> => {
    $supervisorMessages.setKey(ticketId, []);
    return emitter.invoke('fleet:reset-supervisor-session', ticketId);
  },
  setAutoDispatch: (projectId: FleetProjectId, enabled: boolean): Promise<void> => {
    return emitter.invoke('fleet:set-auto-dispatch', projectId, enabled);
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
  getFilesChanged: (ticketId: FleetTicketId): Promise<DiffResponse> => {
    return emitter.invoke('fleet:get-files-changed', ticketId);
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
  goToTicket: (ticketId: FleetTicketId): void => {
    $fleetView.set({ type: 'ticket', ticketId });
  },
};

const listen = () => {
  ipc.on('fleet:task-status', (taskId, status) => {
    const existing = $fleetTasks.get()[taskId];
    if (existing) {
      $fleetTasks.setKey(taskId, { ...existing, status });
    } else {
      // Task was created on main process but renderer doesn't have it yet — bootstrap a minimal entry
      // so the UI can track its status (e.g. show the webview once the sandbox is running).
      $fleetTasks.setKey(taskId, {
        id: taskId,
        projectId: '',
        taskDescription: '',
        status,
        createdAt: Date.now(),
      });
    }
  });

  ipc.on('fleet:task-session', (taskId, sessionId) => {
    const existing = $fleetTasks.get()[taskId];
    if (existing) {
      $fleetTasks.setKey(taskId, { ...existing, sessionId });
    }
  });

  ipc.on('fleet:phase', (ticketId, phase: TicketPhase) => {
    const existing = $fleetTickets.get()[ticketId];
    if (existing) {
      $fleetTickets.setKey(ticketId, { ...existing, phase });
    }
  });

  ipc.on('fleet:supervisor-message', (ticketId, message: FleetSessionMessage) => {
    const existing = $supervisorMessages.get()[ticketId] ?? [];
    $supervisorMessages.setKey(ticketId, [...existing, message]);
  });

  ipc.on('fleet:token-usage', (ticketId, usage: FleetTokenUsage) => {
    const existing = $fleetTickets.get()[ticketId];
    if (existing) {
      $fleetTickets.setKey(ticketId, { ...existing, tokenUsage: usage });
    }
  });

  ipc.on('fleet:pipeline', (_projectId, pipeline: FleetPipeline) => {
    $fleetPipeline.set(pipeline);
  });

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

  setInterval(pollTickets, STATUS_POLL_INTERVAL_MS);
};

listen();
