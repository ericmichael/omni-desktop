import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { execFile } from 'child_process';
import { ipcMain } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import { FleetLoopController } from '@/main/fleet-loop';
import { SandboxManager } from '@/main/sandbox-manager';
import { getWorktreesDir } from '@/main/util';
import type {
  FleetProject,
  FleetProjectId,
  FleetTask,
  FleetTaskId,
  FleetTaskSubmitOptions,
  FleetTicket,
  FleetTicketId,
  FleetTicketPriority,
  GitRepoInfo,
  IpcEvents,
  IpcRendererEvents,
  SandboxProcessStatus,
  StoreData,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// #region JSON-RPC helper

/**
 * Single attempt to connect via WebSocket and call `start_run`.
 * Rejects on connection error or timeout so the caller can retry.
 */
const sendStartRunOnce = (wsUrl: string, prompt: string, timeoutMs = 15_000): Promise<string> => {
  return new Promise((resolve, reject) => {
    const url = wsUrl;
    const ws = new WebSocket(url);
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        ws.close();
        reject(new Error('start_run timed out'));
      });
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'start_run',
          params: { prompt },
        })
      );
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          id?: string;
          result?: { session_id?: string };
          error?: { message?: string };
        };
        if (data.id !== '1') {
          return;
        }
        settle(() => {
          ws.close();
          if (data.error) {
            reject(new Error(data.error.message ?? 'start_run RPC error'));
          } else if (!data.result?.session_id) {
            reject(new Error('No session_id in start_run response'));
          } else {
            resolve(data.result.session_id);
          }
        });
      } catch {
        // Ignore unparseable messages (e.g. notifications)
      }
    });

    ws.addEventListener('error', (err) => {
      settle(() => reject(new Error(`WebSocket error: ${(err as ErrorEvent).message ?? 'unknown'}`)));
    });

    ws.addEventListener('close', () => {
      settle(() => reject(new Error('WebSocket closed before response')));
    });
  });
};

/**
 * Connect to the sandbox WebSocket and call `start_run` with the task description.
 * Retries up to `maxRetries` times with a delay between attempts to handle the case
 * where the WebSocket endpoint isn't ready yet when the sandbox reports `running`.
 */
const sendStartRun = async (wsUrl: string, prompt: string, maxRetries = 10, retryDelayMs = 2_000): Promise<string> => {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await sendStartRunOnce(wsUrl, prompt);
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, retryDelayMs);
        });
      }
    }
  }
  throw lastError ?? new Error('sendStartRun failed');
};

// #endregion

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
  private loops = new Map<FleetTicketId, { controller: FleetLoopController; sandbox: SandboxManager }>();
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
    const remainingTickets = this.getTickets().filter((t) => t.projectId !== id);
    this.setTickets(remainingTickets);
  };

  // #endregion

  // #region Tickets (persisted in electron-store)

  private getTickets = (): FleetTicket[] => {
    return this.store.get('fleetTickets', []);
  };

  private setTickets = (tickets: FleetTicket[]): void => {
    this.store.set('fleetTickets', tickets);
    this.sendToWindow('store:changed', this.store.store);
  };

  addTicket = (input: Omit<FleetTicket, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'taskId'>): FleetTicket => {
    const now = Date.now();
    const ticket: FleetTicket = {
      ...input,
      id: nanoid(),
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const tickets = this.getTickets();
    tickets.push(ticket);
    this.setTickets(tickets);
    return ticket;
  };

  updateTicket = (id: FleetTicketId, patch: Partial<Omit<FleetTicket, 'id' | 'projectId' | 'createdAt'>>): void => {
    const tickets = this.getTickets();
    const index = tickets.findIndex((t) => t.id === id);
    if (index === -1) {
      return;
    }
    tickets[index] = { ...tickets[index]!, ...patch, updatedAt: Date.now() };
    this.setTickets(tickets);
  };

  removeTicket = (id: FleetTicketId): void => {
    const tickets = this.getTickets().filter((t) => t.id !== id);
    this.setTickets(tickets);
  };

  getTicketsByProject = (projectId: FleetProjectId): FleetTicket[] => {
    return this.getTickets().filter((t) => t.projectId === projectId);
  };

  private static PRIORITY_ORDER: Record<FleetTicketPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  getNextTicket = (projectId: FleetProjectId): FleetTicket | null => {
    const tickets = this.getTicketsByProject(projectId);
    const ticketMap = new Map(tickets.map((t) => [t.id, t]));

    const isBlocked = (ticket: FleetTicket): boolean => {
      return ticket.blockedBy.some((blockerId) => {
        const blocker = ticketMap.get(blockerId);
        return blocker && blocker.status !== 'completed' && blocker.status !== 'closed';
      });
    };

    const candidates = tickets.filter((t) => t.status === 'open' && !isBlocked(t));
    candidates.sort((a, b) => {
      const priorityDiff = FleetManager.PRIORITY_ORDER[a.priority] - FleetManager.PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.createdAt - b.createdAt;
    });

    return candidates[0] ?? null;
  };

  submitTicketTask = async (ticketId: FleetTicketId, options: FleetTaskSubmitOptions): Promise<FleetTask> => {
    const ticket = this.getTickets().find((t) => t.id === ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    if (options.loop) {
      return this.submitTicketTaskWithLoop(ticketId, ticket, options);
    }

    const task = await this.submitTask(ticket.projectId, ticket.description || ticket.title, options);

    // Link task ↔ ticket
    const tasks = this.getPersistedTasks();
    const taskIndex = tasks.findIndex((t) => t.id === task.id);
    if (taskIndex !== -1) {
      tasks[taskIndex] = { ...tasks[taskIndex]!, ticketId };
      this.setPersistedTasks(tasks);
    }
    const entry = this.tasks.get(task.id);
    if (entry) {
      entry.task = { ...entry.task, ticketId };
    }

    this.updateTicket(ticketId, { status: 'in_progress', taskId: task.id });

    return { ...task, ticketId };
  };

  // #endregion

  // #region Loop mode

  private submitTicketTaskWithLoop = async (
    ticketId: FleetTicketId,
    ticket: FleetTicket,
    options: FleetTaskSubmitOptions
  ): Promise<FleetTask> => {
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    const maxIterations = options.loopMaxIterations ?? 10;
    let workspaceDir = project.workspaceDir;
    let worktreePath: string | undefined;
    let worktreeName: string | undefined;

    if (options.useWorktree && options.branch) {
      worktreeName = generateWorktreeName();
      worktreePath = await createWorktree(project.workspaceDir, options.branch, worktreeName);
      workspaceDir = worktreePath;
    }

    // Create the first task as a placeholder to return to the caller
    const firstTaskId = nanoid();
    const firstTask: FleetTask = {
      id: firstTaskId,
      projectId: ticket.projectId,
      taskDescription: ticket.description || ticket.title,
      status: { type: 'starting', timestamp: Date.now() },
      createdAt: Date.now(),
      branch: options.branch,
      worktreePath,
      worktreeName,
      ticketId,
      iteration: 1,
    };

    // Create the sandbox for the loop (shared across all iterations)
    const sandbox = new SandboxManager({
      ipcLogger: (entry) => {
        // Route logs to the current task in the loop
        const loop = this.loops.get(ticketId);
        if (loop) {
          const currentTaskId = this.getCurrentLoopTaskId(ticketId);
          if (currentTaskId) {
            this.sendToWindow('fleet:task-log', currentTaskId, entry);
          }
        }
      },
      ipcRawOutput: (data) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          this.sendToWindow('fleet:task-raw-output', currentTaskId, data);
        }
      },
      onStatusChange: (status) => {
        // Update status on current loop task
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          const existing = this.tasks.get(currentTaskId);
          if (existing) {
            existing.task = { ...existing.task, status };
            this.persistTask(existing.task);
          }
          this.sendToWindow('fleet:task-status', currentTaskId, status);
        }

        // When sandbox is running, set wsUrl and start the loop controller
        if (status.type === 'running') {
          const loopEntry = this.loops.get(ticketId);
          if (loopEntry && loopEntry.controller.getStatus() === 'idle') {
            loopEntry.controller.wsUrl = status.data.wsUrl;
            loopEntry.controller.start();
          }
        }
      },
    });

    this.tasks.set(firstTaskId, { task: firstTask, sandbox });
    this.persistTask(firstTask);

    // Create loop controller
    const controller = new FleetLoopController({
      wsUrl: '', // Will be set when sandbox is running
      workspaceDir,
      ticketTitle: ticket.title,
      ticketDescription: ticket.description || ticket.title,
      maxIterations,
      callbacks: {
        onIterationStart: (iteration) => {
          if (iteration === 1) {
            // First task already created
            return { taskId: firstTaskId };
          }
          // Create a new task for this iteration
          const taskId = nanoid();
          const task: FleetTask = {
            id: taskId,
            projectId: ticket.projectId,
            taskDescription: ticket.description || ticket.title,
            status: { type: 'running', timestamp: Date.now(), data: this.getLoopSandboxData(ticketId) },
            createdAt: Date.now(),
            branch: options.branch,
            worktreePath,
            worktreeName,
            ticketId,
            iteration,
          };
          this.tasks.set(taskId, { task, sandbox });
          this.persistTask(task);
          this.sendToWindow('fleet:task-status', taskId, task.status);

          // Update ticket to point to latest task
          this.updateTicket(ticketId, { taskId: taskId, loopIteration: iteration });

          return { taskId };
        },
        onIterationEnd: (taskId, endReason) => {
          const entry = this.tasks.get(taskId);
          if (entry) {
            const status =
              endReason === 'error'
                ? { type: 'error' as const, error: { message: `Run ended: ${endReason}` }, timestamp: Date.now() }
                : { type: 'exited' as const, timestamp: Date.now() };
            entry.task = { ...entry.task, status };
            this.persistTask(entry.task);
            this.sendToWindow('fleet:task-status', taskId, status);
          }
        },
        onSessionStart: (taskId, sessionId) => {
          const entry = this.tasks.get(taskId);
          if (entry) {
            entry.task = { ...entry.task, sessionId };
            this.persistTask(entry.task);
            this.sendToWindow('fleet:task-session', taskId, sessionId);
          }
        },
        onLoopComplete: () => {
          this.updateTicket(ticketId, { loopStatus: 'completed' });
          this.sendToWindow('fleet:ticket-loop-update', ticketId, {
            iteration: maxIterations,
            maxIterations,
            status: 'completed',
          });
          this.loops.delete(ticketId);
        },
        onLoopError: (error) => {
          console.warn(`Loop error for ticket ${ticketId}: ${error.message}`);
          this.updateTicket(ticketId, { loopStatus: 'error' });
          this.sendToWindow('fleet:ticket-loop-update', ticketId, {
            iteration: controller.getIteration(),
            maxIterations,
            status: 'error',
          });
          this.loops.delete(ticketId);
        },
        onLoopBlocked: () => {
          this.updateTicket(ticketId, { loopStatus: 'stopped' });
          this.sendToWindow('fleet:ticket-loop-update', ticketId, {
            iteration: controller.getIteration(),
            maxIterations,
            status: 'stopped',
          });
        },
        onStatusChange: (status, iteration) => {
          this.updateTicket(ticketId, { loopStatus: status, loopIteration: iteration });
          this.sendToWindow('fleet:ticket-loop-update', ticketId, {
            iteration,
            maxIterations,
            status,
          });
        },
      },
    });

    this.loops.set(ticketId, { controller, sandbox });

    // Update ticket
    this.updateTicket(ticketId, {
      status: 'in_progress',
      taskId: firstTaskId,
      loopEnabled: true,
      loopMaxIterations: maxIterations,
      loopIteration: 1,
      loopStatus: 'running',
    });

    // Start sandbox — loop controller will start when sandbox is running
    sandbox.start({
      workspaceDir,
      enableCodeServer: true,
      enableVnc: true,
      useWorkDockerfile: true,
    });

    return firstTask;
  };

  private getCurrentLoopTaskId = (ticketId: FleetTicketId): FleetTaskId | null => {
    const ticket = this.getTickets().find((t) => t.id === ticketId);
    return ticket?.taskId ?? null;
  };

  private getLoopSandboxData = (
    ticketId: FleetTicketId
  ): Extract<SandboxProcessStatus, { type: 'running' }>['data'] => {
    const loopEntry = this.loops.get(ticketId);
    if (!loopEntry) {
      // Return a minimal placeholder — this shouldn't normally be needed
      return {
        sandboxUrl: '',
        wsUrl: '',
        uiUrl: '',
        ports: { sandbox: 0, ui: 0 },
      };
    }
    // Find any task with running status to get the data
    for (const [, entry] of this.tasks) {
      if (entry.task.ticketId === ticketId && entry.task.status.type === 'running') {
        return entry.task.status.data;
      }
    }
    return {
      sandboxUrl: '',
      wsUrl: '',
      uiUrl: '',
      ports: { sandbox: 0, ui: 0 },
    };
  };

  stopLoop = (ticketId: FleetTicketId): void => {
    const loopEntry = this.loops.get(ticketId);
    if (!loopEntry) {
      return;
    }
    loopEntry.controller.stop();
    this.updateTicket(ticketId, { loopStatus: 'stopped' });
    this.sendToWindow('fleet:ticket-loop-update', ticketId, {
      iteration: loopEntry.controller.getIteration(),
      maxIterations: loopEntry.controller.getMaxIterations(),
      status: 'stopped',
    });
    // Don't delete loop entry or stop sandbox — keep sandbox alive for inspection
  };

  resumeLoop = async (ticketId: FleetTicketId): Promise<void> => {
    const ticket = this.getTickets().find((t) => t.id === ticketId);
    if (!ticket || !ticket.loopEnabled) {
      return;
    }

    // Stop any existing loop controller for this ticket
    const existingLoop = this.loops.get(ticketId);
    if (existingLoop) {
      existingLoop.controller.stop();
      this.loops.delete(ticketId);
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return;
    }

    const maxIterations = ticket.loopMaxIterations ?? 10;
    const resumeIteration = (ticket.loopIteration ?? 0) + 1;

    if (resumeIteration > maxIterations) {
      this.updateTicket(ticketId, { loopStatus: 'completed' });
      return;
    }

    // Find an existing sandbox for this ticket (from its most recent task)
    let sandbox: SandboxManager | undefined;
    let workspaceDir = project.workspaceDir;

    if (ticket.taskId) {
      const taskEntry = this.tasks.get(ticket.taskId);
      if (taskEntry) {
        sandbox = taskEntry.sandbox;
        workspaceDir = taskEntry.task.worktreePath ?? project.workspaceDir;
      }
    }

    // If no running sandbox found, we need to create a new one
    const sandboxStatus = sandbox?.getStatus();
    if (!sandbox || !sandboxStatus || sandboxStatus.type !== 'running') {
      // Re-submit with loop — this creates a fresh sandbox
      await this.submitTicketTaskWithLoop(ticketId, ticket, {
        loop: true,
        loopMaxIterations: maxIterations,
      });
      return;
    }

    // Sandbox is alive — create a new loop controller that picks up from the next iteration
    const controller = new FleetLoopController({
      wsUrl: sandboxStatus.data.wsUrl,
      workspaceDir,
      ticketTitle: ticket.title,
      ticketDescription: ticket.description || ticket.title,
      maxIterations,
      startFromIteration: resumeIteration,
      callbacks: this.buildLoopCallbacks(ticketId, ticket, sandbox, maxIterations),
    });

    this.loops.set(ticketId, { controller, sandbox });
    this.updateTicket(ticketId, { loopStatus: 'running', loopIteration: resumeIteration });
    controller.start();
  };

  private buildLoopCallbacks = (
    ticketId: FleetTicketId,
    ticket: FleetTicket,
    sandbox: SandboxManager,
    maxIterations: number
  ): ConstructorParameters<typeof FleetLoopController>[0]['callbacks'] => {
    return {
      onIterationStart: (iteration) => {
        const taskId = nanoid();
        const task: FleetTask = {
          id: taskId,
          projectId: ticket.projectId,
          taskDescription: ticket.description || ticket.title,
          status: { type: 'running', timestamp: Date.now(), data: this.getLoopSandboxData(ticketId) },
          createdAt: Date.now(),
          ticketId,
          iteration,
        };
        this.tasks.set(taskId, { task, sandbox });
        this.persistTask(task);
        this.sendToWindow('fleet:task-status', taskId, task.status);
        this.updateTicket(ticketId, { taskId, loopIteration: iteration });
        return { taskId };
      },
      onIterationEnd: (taskId, endReason) => {
        const entry = this.tasks.get(taskId);
        if (entry) {
          const status =
            endReason === 'error'
              ? { type: 'error' as const, error: { message: `Run ended: ${endReason}` }, timestamp: Date.now() }
              : { type: 'exited' as const, timestamp: Date.now() };
          entry.task = { ...entry.task, status };
          this.persistTask(entry.task);
          this.sendToWindow('fleet:task-status', taskId, status);
        }
      },
      onSessionStart: (taskId, sessionId) => {
        const entry = this.tasks.get(taskId);
        if (entry) {
          entry.task = { ...entry.task, sessionId };
          this.persistTask(entry.task);
          this.sendToWindow('fleet:task-session', taskId, sessionId);
        }
      },
      onLoopComplete: () => {
        this.updateTicket(ticketId, { loopStatus: 'completed' });
        this.sendToWindow('fleet:ticket-loop-update', ticketId, {
          iteration: maxIterations,
          maxIterations,
          status: 'completed',
        });
        this.loops.delete(ticketId);
      },
      onLoopError: (error) => {
        console.warn(`Loop error for ticket ${ticketId}: ${error.message}`);
        this.updateTicket(ticketId, { loopStatus: 'error' });
        const loopEntry = this.loops.get(ticketId);
        this.sendToWindow('fleet:ticket-loop-update', ticketId, {
          iteration: loopEntry?.controller.getIteration() ?? 0,
          maxIterations,
          status: 'error',
        });
        this.loops.delete(ticketId);
      },
      onLoopBlocked: () => {
        const loopEntry = this.loops.get(ticketId);
        this.updateTicket(ticketId, { loopStatus: 'stopped' });
        this.sendToWindow('fleet:ticket-loop-update', ticketId, {
          iteration: loopEntry?.controller.getIteration() ?? 0,
          maxIterations,
          status: 'stopped',
        });
      },
      onStatusChange: (status, iteration) => {
        this.updateTicket(ticketId, { loopStatus: status, loopIteration: iteration });
        this.sendToWindow('fleet:ticket-loop-update', ticketId, {
          iteration,
          maxIterations,
          status,
        });
      },
    };
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

  // #region Task session initialization

  private initializeTaskSession = async (taskId: FleetTaskId, wsUrl: string, prompt: string): Promise<void> => {
    try {
      const sessionId = await sendStartRun(wsUrl, prompt);
      const existing = this.tasks.get(taskId);
      if (existing) {
        existing.task = { ...existing.task, sessionId };
        this.persistTask(existing.task);
        this.sendToWindow('fleet:task-session', taskId, sessionId);
      }
    } catch (error) {
      console.warn(`Failed to initialize task session for ${taskId}: ${(error as Error).message}`);
    }
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

        // When sandbox is running, send the task description to the agent via JSON-RPC
        if (status.type === 'running') {
          void this.initializeTaskSession(taskId, status.data.wsUrl, taskDescription);
        }
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

    // If this task belongs to an active loop, stop the loop too
    if (entry.task.ticketId) {
      const loopEntry = this.loops.get(entry.task.ticketId);
      if (loopEntry) {
        this.stopLoop(entry.task.ticketId);
      }
    }

    await entry.sandbox.stop();
  };

  removeTask = async (taskId: FleetTaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }

    // If this task belongs to an active loop, stop the loop too
    if (entry.task.ticketId) {
      const loopEntry = this.loops.get(entry.task.ticketId);
      if (loopEntry) {
        this.stopLoop(entry.task.ticketId);
        this.loops.delete(entry.task.ticketId);
      }
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
    // Stop all loops first
    for (const [ticketId, loopEntry] of this.loops) {
      loopEntry.controller.stop();
      this.loops.delete(ticketId);
    }

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
  ipc.handle('fleet:add-ticket', (_, ticket) => fleetManager.addTicket(ticket));
  ipc.handle('fleet:update-ticket', (_, id, patch) => fleetManager.updateTicket(id, patch));
  ipc.handle('fleet:remove-ticket', (_, id) => fleetManager.removeTicket(id));
  ipc.handle('fleet:get-tickets', (_, projectId) => fleetManager.getTicketsByProject(projectId));
  ipc.handle('fleet:get-next-ticket', (_, projectId) => fleetManager.getNextTicket(projectId));
  ipc.handle('fleet:submit-ticket-task', (_, ticketId, options) => fleetManager.submitTicketTask(ticketId, options));
  ipc.handle('fleet:stop-loop', (_, ticketId) => fleetManager.stopLoop(ticketId));
  ipc.handle('fleet:resume-loop', (_, ticketId) => fleetManager.resumeLoop(ticketId));

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
    ipcMain.removeHandler('fleet:add-ticket');
    ipcMain.removeHandler('fleet:update-ticket');
    ipcMain.removeHandler('fleet:remove-ticket');
    ipcMain.removeHandler('fleet:get-tickets');
    ipcMain.removeHandler('fleet:get-next-ticket');
    ipcMain.removeHandler('fleet:submit-ticket-task');
    ipcMain.removeHandler('fleet:stop-loop');
    ipcMain.removeHandler('fleet:resume-loop');
  };

  return [fleetManager, cleanup] as const;
};
