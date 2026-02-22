import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { execFile } from 'child_process';
import { ipcMain } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import { SandboxManager } from '@/main/sandbox-manager';
import { getWorktreesDir } from '@/main/util';
import type {
  FleetProject,
  FleetProjectId,
  FleetTask,
  FleetTaskId,
  FleetTaskSubmitOptions,
  GitRepoInfo,
  IpcEvents,
  IpcRendererEvents,
  StoreData,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// #region Name generator

const ADJECTIVES = [
  'bold',
  'calm',
  'cool',
  'dark',
  'deep',
  'dry',
  'fast',
  'firm',
  'flat',
  'free',
  'full',
  'glad',
  'gold',
  'good',
  'gray',
  'hale',
  'keen',
  'kind',
  'last',
  'lean',
  'long',
  'loud',
  'mild',
  'neat',
  'pale',
  'pure',
  'rare',
  'rich',
  'ripe',
  'safe',
  'slim',
  'soft',
  'sure',
  'tall',
  'tame',
  'tidy',
  'tiny',
  'true',
  'vast',
  'warm',
  'wide',
  'wild',
  'wise',
  'aged',
  'airy',
  'apt',
  'bare',
  'blue',
  'busy',
  'cold',
];

const NOUNS = [
  'ant',
  'ape',
  'bat',
  'bear',
  'bee',
  'bird',
  'boar',
  'buck',
  'bull',
  'calf',
  'cat',
  'clam',
  'cod',
  'colt',
  'crab',
  'crow',
  'deer',
  'dog',
  'dove',
  'duck',
  'eagle',
  'eel',
  'elk',
  'fawn',
  'finch',
  'fish',
  'flea',
  'fly',
  'fox',
  'frog',
  'goat',
  'goose',
  'gull',
  'hare',
  'hawk',
  'hen',
  'hog',
  'horse',
  'jay',
  'lark',
  'lion',
  'lynx',
  'mare',
  'mink',
  'mole',
  'moth',
  'mule',
  'newt',
  'owl',
  'ox',
  'pike',
  'pony',
  'puma',
  'ram',
  'rat',
  'rook',
  'seal',
  'slug',
  'snail',
  'swan',
];

const generateWorktreeName = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
};

// #endregion

// #region Git helpers

const checkGitRepo = async (workspaceDir: string): Promise<GitRepoInfo> => {
  try {
    await execFileAsync('git', ['-C', workspaceDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch {
    return { isGitRepo: false };
  }

  try {
    const [branchResult, currentResult] = await Promise.all([
      execFileAsync('git', ['-C', workspaceDir, 'branch', '--list', '--format=%(refname:short)'], {
        encoding: 'utf8',
        timeout: 5_000,
      }),
      execFileAsync('git', ['-C', workspaceDir, 'branch', '--show-current'], {
        encoding: 'utf8',
        timeout: 5_000,
      }),
    ]);

    const branches = branchResult.stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);

    const currentBranch = currentResult.stdout.trim();

    return { isGitRepo: true, branches, currentBranch };
  } catch {
    return { isGitRepo: false };
  }
};

const createWorktree = async (workspaceDir: string, branch: string, name: string): Promise<string> => {
  const worktreesDir = getWorktreesDir();
  await fs.mkdir(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, name);
  const fleetBranch = `fleet/${name}`;

  await execFileAsync('git', ['-C', workspaceDir, 'worktree', 'add', '-b', fleetBranch, worktreePath, branch], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  return worktreePath;
};

const removeWorktree = async (workspaceDir: string, worktreePath: string, worktreeName: string): Promise<void> => {
  try {
    await execFileAsync('git', ['-C', workspaceDir, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (error) {
    console.warn(`Failed to remove worktree ${worktreePath}: ${error}`);
  }

  try {
    await execFileAsync('git', ['-C', workspaceDir, 'branch', '-D', `fleet/${worktreeName}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch (error) {
    console.warn(`Failed to delete branch fleet/${worktreeName}: ${error}`);
  }
};

// #endregion

export class FleetManager {
  private tasks = new Map<FleetTaskId, { task: FleetTask; sandbox: SandboxManager }>();
  private store: Store<StoreData>;
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

  constructor(arg: { store: Store<StoreData>; sendToWindow: FleetManager['sendToWindow'] }) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
  }

  // #region Projects (persisted in electron-store)

  private getProjects = (): FleetProject[] => {
    return this.store.get('fleetProjects', []);
  };

  private setProjects = (projects: FleetProject[]): void => {
    this.store.set('fleetProjects', projects);
    this.sendToWindow('store:changed', this.store.store);
  };

  addProject = (input: Omit<FleetProject, 'id' | 'createdAt'>): FleetProject => {
    const project: FleetProject = {
      ...input,
      id: nanoid(),
      createdAt: Date.now(),
    };
    const projects = this.getProjects();
    projects.push(project);
    this.setProjects(projects);
    return project;
  };

  updateProject = (id: FleetProjectId, patch: Partial<Omit<FleetProject, 'id' | 'createdAt'>>): void => {
    const projects = this.getProjects();
    const index = projects.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    projects[index] = { ...projects[index]!, ...patch };
    this.setProjects(projects);
  };

  removeProject = async (id: FleetProjectId): Promise<void> => {
    // Stop all tasks for this project
    for (const [taskId, entry] of this.tasks) {
      if (entry.task.projectId === id) {
        await entry.sandbox.exit();
        this.tasks.delete(taskId);
      }
    }
    const projects = this.getProjects().filter((p) => p.id !== id);
    this.setProjects(projects);
    const remainingTasks = this.getPersistedTasks().filter((t) => t.projectId !== id);
    this.setPersistedTasks(remainingTasks);
  };

  // #endregion

  // #region Task persistence

  private getPersistedTasks = (): FleetTask[] => {
    return this.store.get('fleetTasks', []);
  };

  private setPersistedTasks = (tasks: FleetTask[]): void => {
    this.store.set('fleetTasks', tasks);
    this.sendToWindow('store:changed', this.store.store);
  };

  private persistTask = (task: FleetTask): void => {
    const tasks = this.getPersistedTasks();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) {
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    this.setPersistedTasks(tasks);
  };

  private removePersistedTask = (taskId: FleetTaskId): void => {
    const tasks = this.getPersistedTasks().filter((t) => t.id !== taskId);
    this.setPersistedTasks(tasks);
  };

  restorePersistedTasks = (): void => {
    const tasks = this.getPersistedTasks();
    const updated: FleetTask[] = [];
    for (const task of tasks) {
      if (task.status.type !== 'exited' && task.status.type !== 'error') {
        updated.push({ ...task, status: { type: 'exited', timestamp: Date.now() } });
      } else {
        updated.push(task);
      }
    }
    this.setPersistedTasks(updated);
  };

  // #endregion

  // #region Tasks (in-memory sandboxes + persisted records)

  submitTask = async (
    projectId: FleetProjectId,
    taskDescription: string,
    options: FleetTaskSubmitOptions
  ): Promise<FleetTask> => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const taskId = nanoid();
    let workspaceDir = project.workspaceDir;
    let worktreePath: string | undefined;
    let worktreeName: string | undefined;

    if (options.useWorktree && options.branch) {
      worktreeName = generateWorktreeName();
      worktreePath = await createWorktree(project.workspaceDir, options.branch, worktreeName);
      workspaceDir = worktreePath;
    }

    const task: FleetTask = {
      id: taskId,
      projectId,
      taskDescription,
      status: { type: 'starting', timestamp: Date.now() },
      createdAt: Date.now(),
      branch: options.branch,
      worktreePath,
      worktreeName,
    };

    const sandbox = new SandboxManager({
      ipcLogger: (entry) => {
        this.sendToWindow('fleet:task-log', taskId, entry);
      },
      ipcRawOutput: (data) => {
        this.sendToWindow('fleet:task-raw-output', taskId, data);
      },
      onStatusChange: (status) => {
        const existing = this.tasks.get(taskId);
        if (existing) {
          existing.task = { ...existing.task, status };
          this.persistTask(existing.task);
        }
        this.sendToWindow('fleet:task-status', taskId, status);
      },
    });

    this.tasks.set(taskId, { task, sandbox });
    this.persistTask(task);

    sandbox.start({
      workspaceDir,
      enableCodeServer: true,
      enableVnc: true,
      useWorkDockerfile: true,
    });

    return task;
  };

  getTasks = (): FleetTask[] => {
    const merged = new Map<FleetTaskId, FleetTask>();
    for (const task of this.getPersistedTasks()) {
      merged.set(task.id, task);
    }
    for (const [id, entry] of this.tasks) {
      merged.set(id, entry.task);
    }
    return [...merged.values()];
  };

  stopTask = async (taskId: FleetTaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }
    await entry.sandbox.stop();
  };

  removeTask = async (taskId: FleetTaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }
    await entry.sandbox.exit();

    // Clean up worktree if one was created
    if (entry.task.worktreePath && entry.task.worktreeName) {
      const project = this.getProjects().find((p) => p.id === entry.task.projectId);
      if (project) {
        await removeWorktree(project.workspaceDir, entry.task.worktreePath, entry.task.worktreeName);
      }
    }

    this.tasks.delete(taskId);
    this.removePersistedTask(taskId);
  };

  // #endregion

  exit = async (): Promise<void> => {
    const exits = [...this.tasks.values()].map((entry) => entry.sandbox.exit());
    await Promise.allSettled(exits);
    this.tasks.clear();
  };
}

export const createFleetManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  store: Store<StoreData>;
}) => {
  const { ipc, sendToWindow, store } = arg;

  const fleetManager = new FleetManager({ store, sendToWindow });
  fleetManager.restorePersistedTasks();

  ipc.handle('fleet:add-project', (_, project) => fleetManager.addProject(project));
  ipc.handle('fleet:update-project', (_, id, patch) => fleetManager.updateProject(id, patch));
  ipc.handle('fleet:remove-project', (_, id) => fleetManager.removeProject(id));
  ipc.handle('fleet:check-git-repo', (_, workspaceDir) => checkGitRepo(workspaceDir));
  ipc.handle('fleet:submit-task', (_, projectId, taskDescription, options) =>
    fleetManager.submitTask(projectId, taskDescription, options)
  );
  ipc.handle('fleet:get-tasks', () => fleetManager.getTasks());
  ipc.handle('fleet:stop-task', (_, taskId) => fleetManager.stopTask(taskId));
  ipc.handle('fleet:remove-task', (_, taskId) => fleetManager.removeTask(taskId));

  const cleanup = async () => {
    await fleetManager.exit();
    ipcMain.removeHandler('fleet:add-project');
    ipcMain.removeHandler('fleet:update-project');
    ipcMain.removeHandler('fleet:remove-project');
    ipcMain.removeHandler('fleet:check-git-repo');
    ipcMain.removeHandler('fleet:submit-task');
    ipcMain.removeHandler('fleet:get-tasks');
    ipcMain.removeHandler('fleet:stop-task');
    ipcMain.removeHandler('fleet:remove-task');
  };

  return [fleetManager, cleanup] as const;
};
