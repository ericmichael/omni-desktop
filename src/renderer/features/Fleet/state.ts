import { Terminal } from '@xterm/xterm';
import { atom, map } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  FleetProject,
  FleetProjectId,
  FleetTask,
  FleetTaskId,
  FleetTaskSubmitOptions,
  GitRepoInfo,
} from '@/shared/types';

/**
 * All active fleet tasks, keyed by task ID. Ephemeral — not persisted.
 */
export const $fleetTasks = map<Record<FleetTaskId, FleetTask>>({});

/**
 * Which fleet view is active: dashboard = no selection, project = project detail, task = task sandbox view.
 */
export const $fleetView = atom<
  { type: 'dashboard' } | { type: 'project'; projectId: FleetProjectId } | { type: 'task'; taskId: FleetTaskId }
>({ type: 'dashboard' });

/**
 * Per-task xterm instances for log output.
 */
export const $fleetTaskXTerms = map<Record<FleetTaskId, Terminal>>({});

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

  // Navigation
  goToDashboard: (): void => {
    $fleetView.set({ type: 'dashboard' });
  },
  goToProject: (projectId: FleetProjectId): void => {
    $fleetView.set({ type: 'project', projectId });
  },
  goToTask: (taskId: FleetTaskId): void => {
    $fleetView.set({ type: 'task', taskId });
  },
};

const listen = () => {
  ipc.on('fleet:task-status', (_, taskId, status) => {
    const existing = $fleetTasks.get()[taskId];
    if (existing) {
      $fleetTasks.setKey(taskId, { ...existing, status });
    }
    if (status.type === 'exited') {
      teardownTaskTerminal(taskId);
    }
  });

  ipc.on('fleet:task-raw-output', (_, taskId, data) => {
    const xterm = $fleetTaskXTerms.get()[taskId];
    xterm?.write(data);
  });

  const pollTasks = async () => {
    const tasks = await emitter.invoke('fleet:get-tasks');
    const newMap: Record<FleetTaskId, FleetTask> = {};
    for (const task of tasks) {
      newMap[task.id] = task;
    }
    $fleetTasks.set(newMap);
  };

  setInterval(pollTasks, STATUS_POLL_INTERVAL_MS);
};

listen();
