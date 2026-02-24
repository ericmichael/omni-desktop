import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { execFile } from 'child_process';
import { app, ipcMain } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import type { FleetLoopCallbacks } from '@/main/fleet-loop';
import { FleetLoopController } from '@/main/fleet-loop';
import { buildNudgePrompt, interpolatePromptTemplate } from '@/main/fleet-prompt-builder';
import { SandboxManager } from '@/main/sandbox-manager';
import { getWorktreesDir } from '@/main/util';
import { DEFAULT_PIPELINE } from '@/shared/fleet-defaults';
import type {
  FleetChecklistItem,
  FleetChecklistItemId,
  FleetColumn,
  FleetColumnId,
  FleetPhase,
  FleetPhaseId,
  FleetPhaseStatus,
  FleetPipeline,
  FleetProject,
  FleetProjectId,
  FleetSentinel,
  FleetSessionMessage,
  FleetTask,
  FleetTaskId,
  FleetTaskSubmitOptions,
  FleetTicket,
  FleetTicketId,
  FleetTicketPriority,
  FleetTicketStatus,
  GitRepoInfo,
  IpcEvents,
  IpcRendererEvents,
  SandboxProcessStatus,
  StoreData,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// #region JSON-RPC helper

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
        // Ignore unparseable messages
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

// #region Status mapping

/**
 * Map column position to legacy FleetTicketStatus for backwards compat.
 */
const deriveStatusFromColumn = (columnId: FleetColumnId, pipeline: FleetPipeline): FleetTicketStatus => {
  const columns = pipeline.columns;
  const idx = columns.findIndex((c) => c.id === columnId);
  if (idx === -1) {
    return 'open';
  }
  // First column = open, last column = completed, anything else = in_progress
  if (idx === 0) {
    return 'open';
  }
  if (idx === columns.length - 1) {
    return 'completed';
  }
  return 'in_progress';
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

  // #region Pipeline helpers

  getPipeline = (projectId: FleetProjectId): FleetPipeline => {
    const project = this.getProjects().find((p) => p.id === projectId);
    return project?.pipeline ?? DEFAULT_PIPELINE;
  };

  private getColumn = (projectId: FleetProjectId, columnId: FleetColumnId): FleetColumn | undefined => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns.find((c) => c.id === columnId);
  };

  private getNextColumn = (projectId: FleetProjectId, columnId: FleetColumnId): FleetColumn | undefined => {
    const pipeline = this.getPipeline(projectId);
    const idx = pipeline.columns.findIndex((c) => c.id === columnId);
    if (idx === -1 || idx >= pipeline.columns.length - 1) {
      return undefined;
    }
    return pipeline.columns[idx + 1];
  };

  private getPreviousColumn = (projectId: FleetProjectId, columnId: FleetColumnId): FleetColumn | undefined => {
    const pipeline = this.getPipeline(projectId);
    const idx = pipeline.columns.findIndex((c) => c.id === columnId);
    if (idx <= 0) {
      return undefined;
    }
    return pipeline.columns[idx - 1];
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

  private getTicketById = (ticketId: FleetTicketId): FleetTicket | undefined => {
    return this.getTickets().find((t) => t.id === ticketId);
  };

  addTicket = (
    input: Omit<
      FleetTicket,
      'id' | 'createdAt' | 'updatedAt' | 'status' | 'taskId' | 'columnId' | 'currentPhaseId' | 'phases' | 'checklist'
    >
  ): FleetTicket => {
    const now = Date.now();
    const ticket: FleetTicket = {
      ...input,
      id: nanoid(),
      status: 'open',
      columnId: null,
      currentPhaseId: null,
      phases: [],
      checklist: {},
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

  // #endregion

  // #region Phase lifecycle

  private createPhase = (ticket: FleetTicket, column: FleetColumn): FleetPhase => {
    const existingAttempts = ticket.phases.filter((p) => p.columnId === column.id).length;
    const phase: FleetPhase = {
      id: nanoid(),
      ticketId: ticket.id,
      columnId: column.id,
      attempt: existingAttempts + 1,
      status: 'pending',
      taskIds: [],
      loop: {
        enabled: column.maxIterations > 0,
        maxIterations: column.maxIterations,
        currentIteration: 0,
        status: null,
      },
      enteredAt: Date.now(),
    };

    const pipeline = this.getPipeline(ticket.projectId);
    const legacyStatus = deriveStatusFromColumn(column.id, pipeline);

    // Seed per-column checklist from column defaults if this column key doesn't exist yet
    let checklist = ticket.checklist;
    if (!(column.id in checklist) && column.defaultChecklist.length > 0) {
      checklist = {
        ...checklist,
        [column.id]: column.defaultChecklist.map((item) => ({ ...item, id: `chk-${nanoid()}` })),
      };
    }

    this.updateTicket(ticket.id, {
      columnId: column.id,
      currentPhaseId: phase.id,
      phases: [...ticket.phases, phase],
      checklist,
      status: legacyStatus,
      // Sync legacy loop fields
      loopEnabled: phase.loop.enabled,
      loopMaxIterations: phase.loop.maxIterations,
      loopIteration: 0,
      loopStatus: undefined,
    });

    // Re-read ticket after update to get fresh data for the event
    const updated = this.getTicketById(ticket.id);
    const updatedPhase = updated?.phases.find((p) => p.id === phase.id);
    if (updatedPhase) {
      this.sendToWindow('fleet:phase-update', ticket.id, updatedPhase);
    }

    return phase;
  };

  private closeCurrentPhase = (
    ticket: FleetTicket,
    status: FleetPhaseStatus,
    reviewNote?: string,
    exitSentinel?: FleetSentinel
  ): void => {
    if (!ticket.currentPhaseId) {
      return;
    }
    const phases = [...ticket.phases];
    const idx = phases.findIndex((p) => p.id === ticket.currentPhaseId);
    if (idx === -1) {
      return;
    }
    phases[idx] = {
      ...phases[idx]!,
      status,
      exitedAt: Date.now(),
      ...(reviewNote !== undefined && { reviewNote }),
      ...(exitSentinel !== undefined && { exitSentinel }),
    };
    this.updateTicket(ticket.id, { phases, currentPhaseId: null });

    this.sendToWindow('fleet:phase-update', ticket.id, phases[idx]!);
  };

  private updatePhaseLoop = (
    ticketId: FleetTicketId,
    phaseId: FleetPhaseId,
    loopPatch: Partial<FleetPhase['loop']>
  ): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    const phases = [...ticket.phases];
    const idx = phases.findIndex((p) => p.id === phaseId);
    if (idx === -1) {
      return;
    }
    const phase = phases[idx]!;
    phases[idx] = {
      ...phase,
      loop: { ...phase.loop, ...loopPatch },
    };

    // Sync legacy fields
    const updatedLoop = phases[idx]!.loop;
    this.updateTicket(ticketId, {
      phases,
      loopStatus: updatedLoop.status ?? undefined,
      loopIteration: updatedLoop.currentIteration,
      loopMaxIterations: updatedLoop.maxIterations,
    });

    // Emit legacy loop update for backwards compat
    this.sendToWindow('fleet:ticket-loop-update', ticketId, {
      iteration: updatedLoop.currentIteration,
      maxIterations: updatedLoop.maxIterations,
      status: updatedLoop.status ?? 'running',
    });
  };

  // #endregion

  // #region Column transitions

  advanceTicket = (ticketId: FleetTicketId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.columnId) {
      return;
    }

    const nextColumn = this.getNextColumn(ticket.projectId, ticket.columnId);
    if (!nextColumn) {
      // Already at terminal column
      return;
    }

    // Close current phase if open
    const freshTicket = this.getTicketById(ticketId)!;
    if (freshTicket.currentPhaseId) {
      this.closeCurrentPhase(freshTicket, 'completed');
    }

    // Re-read after close
    const ticketAfterClose = this.getTicketById(ticketId)!;
    const phase = this.createPhase(ticketAfterClose, nextColumn);

    // Auto-start if column supports it
    if (nextColumn.autoStart && nextColumn.maxIterations > 0) {
      // Use setTimeout(0) to prevent re-entrancy from callback chains
      setTimeout(() => {
        void this.startPhase(ticketId);
      }, 0);
    } else {
      // Passive or gate column — just emit the phase
      this.sendToWindow('fleet:phase-update', ticketId, phase);
    }
  };

  moveTicketToColumn = (ticketId: FleetTicketId, columnId: FleetColumnId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const column = this.getColumn(ticket.projectId, columnId);
    if (!column) {
      return;
    }

    // Stop any running loop
    this.stopLoopIfRunning(ticketId);

    // Skip current phase
    const freshTicket = this.getTicketById(ticketId)!;
    if (freshTicket.currentPhaseId) {
      this.closeCurrentPhase(freshTicket, 'skipped');
    }

    // Create new phase in target column
    const ticketAfterClose = this.getTicketById(ticketId)!;
    this.createPhase(ticketAfterClose, column);
  };

  kickbackTicket = (ticketId: FleetTicketId, targetColumnId: FleetColumnId, reviewNote?: string): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const targetColumn = this.getColumn(ticket.projectId, targetColumnId);
    if (!targetColumn) {
      return;
    }

    // Stop any running loop
    this.stopLoopIfRunning(ticketId);

    // Close current phase as rejected
    const freshTicket = this.getTicketById(ticketId)!;
    if (freshTicket.currentPhaseId) {
      this.closeCurrentPhase(freshTicket, 'rejected', reviewNote);
    }

    // Create new phase in target column
    const ticketAfterClose = this.getTicketById(ticketId)!;
    const phase = this.createPhase(ticketAfterClose, targetColumn);

    // Auto-start if the target column supports it
    if (targetColumn.autoStart && targetColumn.maxIterations > 0) {
      setTimeout(() => {
        void this.startPhase(ticketId);
      }, 0);
    } else {
      this.sendToWindow('fleet:phase-update', ticketId, phase);
    }
  };

  approvePhase = (ticketId: FleetTicketId, reviewNote?: string): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.currentPhaseId) {
      return;
    }

    this.closeCurrentPhase(ticket, 'completed', reviewNote);
    this.advanceTicket(ticketId);
  };

  rejectPhase = (ticketId: FleetTicketId, reviewNote: string): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.columnId) {
      return;
    }

    const prevColumn = this.getPreviousColumn(ticket.projectId, ticket.columnId);
    if (!prevColumn) {
      // Can't kickback from first column
      return;
    }

    this.kickbackTicket(ticketId, prevColumn.id, reviewNote);
  };

  // #endregion

  // #region Phase agent loop

  startPhase = (ticketId: FleetTicketId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.columnId || !ticket.currentPhaseId) {
      return;
    }

    const column = this.getColumn(ticket.projectId, ticket.columnId);
    if (!column || column.maxIterations === 0) {
      return;
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return;
    }

    // Reuse existing sandbox if alive
    let sandbox: SandboxManager | undefined;
    let workspaceDir = project.workspaceDir;
    const existingLoop = this.loops.get(ticketId);
    if (existingLoop) {
      const sbStatus = existingLoop.sandbox.getStatus();
      if (sbStatus?.type === 'running') {
        sandbox = existingLoop.sandbox;
        // Find workspace from any existing task
        for (const [, entry] of this.tasks) {
          if (entry.task.ticketId === ticketId && entry.task.worktreePath) {
            workspaceDir = entry.task.worktreePath;
            break;
          }
        }
      }
      existingLoop.controller.stop();
      this.loops.delete(ticketId);
    }

    const phaseId = ticket.currentPhaseId;
    const maxIterations = column.maxIterations;

    // Build column-aware prompt
    const buildPromptFn = (iteration: number): string => {
      const freshTicket = this.getTicketById(ticketId);
      return interpolatePromptTemplate(column.promptTemplate, {
        ticket: {
          title: freshTicket?.title ?? ticket.title,
          description: freshTicket?.description ?? ticket.description,
        },
        column: { label: column.label, validSentinels: column.validSentinels },
        checklist: freshTicket?.checklist[column.id] ?? [],
        phaseHistory: freshTicket?.phases.filter((p) => p.id !== phaseId) ?? [],
        iteration,
      });
    };

    const nudgePrompt = buildNudgePrompt(column.validSentinels);
    const callbacks = this.buildPhaseLoopCallbacks(ticketId, phaseId, column);

    if (!sandbox) {
      // Need to create a new sandbox
      sandbox = this.createPhaseSandbox(ticketId);
      sandbox.start({ workspaceDir, useWorkDockerfile: true });
    }

    const currentSbStatus = sandbox.getStatus();
    const controller = new FleetLoopController({
      wsUrl: currentSbStatus?.type === 'running' ? currentSbStatus.data.wsUrl : '',
      workspaceDir,
      maxIterations,
      validSentinels: column.validSentinels,
      buildPrompt: buildPromptFn,
      nudgePrompt,
      ticketTitle: ticket.title,
      callbacks,
    });

    this.loops.set(ticketId, { controller, sandbox });

    // Update phase status
    const phases = [...ticket.phases];
    const phaseIdx = phases.findIndex((p) => p.id === phaseId);
    if (phaseIdx !== -1) {
      phases[phaseIdx] = { ...phases[phaseIdx]!, status: 'running' };
      this.updateTicket(ticketId, { phases, loopStatus: 'running' });
    }

    // If sandbox is already running, start the controller immediately
    const currentStatus = sandbox.getStatus();
    if (currentStatus?.type === 'running') {
      controller.wsUrl = currentStatus.data.wsUrl;
      controller.start();
    }
    // Otherwise, the sandbox onStatusChange callback will start it when ready
  };

  stopPhase = (ticketId: FleetTicketId): void => {
    this.stopLoop(ticketId);
  };

  resumePhase = async (ticketId: FleetTicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.columnId || !ticket.currentPhaseId) {
      // Fall back to legacy resume if no phase info
      await this.resumeLoop(ticketId);
      return;
    }

    const column = this.getColumn(ticket.projectId, ticket.columnId);
    if (!column) {
      return;
    }

    const phase = ticket.phases.find((p) => p.id === ticket.currentPhaseId);
    if (!phase) {
      return;
    }

    // Stop existing controller
    const existingLoop = this.loops.get(ticketId);
    if (existingLoop) {
      existingLoop.controller.stop();
      this.loops.delete(ticketId);
    }

    const resumeIteration = (phase.loop.currentIteration ?? 0) + 1;
    if (resumeIteration > column.maxIterations) {
      this.updatePhaseLoop(ticketId, phase.id, { status: 'completed' });
      return;
    }

    // Reuse existing sandbox if alive
    let sandbox: SandboxManager | undefined;
    let workspaceDir = this.getProjects().find((p) => p.id === ticket.projectId)?.workspaceDir ?? '';

    if (existingLoop) {
      const sbStatus = existingLoop.sandbox.getStatus();
      if (sbStatus?.type === 'running') {
        sandbox = existingLoop.sandbox;
      }
    }

    if (!sandbox && ticket.taskId) {
      const taskEntry = this.tasks.get(ticket.taskId);
      if (taskEntry) {
        const sbStatus = taskEntry.sandbox.getStatus();
        if (sbStatus?.type === 'running') {
          sandbox = taskEntry.sandbox;
          workspaceDir = taskEntry.task.worktreePath ?? workspaceDir;
        }
      }
    }

    if (!sandbox) {
      // Restart the full phase
      this.startPhase(ticketId);
      return;
    }

    const phaseId = phase.id;
    const maxIterations = column.maxIterations;
    const buildPromptFn = (iteration: number): string => {
      const freshTicket = this.getTicketById(ticketId);
      return interpolatePromptTemplate(column.promptTemplate, {
        ticket: {
          title: freshTicket?.title ?? ticket.title,
          description: freshTicket?.description ?? ticket.description,
        },
        column: { label: column.label, validSentinels: column.validSentinels },
        checklist: freshTicket?.checklist[column.id] ?? [],
        phaseHistory: freshTicket?.phases.filter((p) => p.id !== phaseId) ?? [],
        iteration,
      });
    };

    const nudgePrompt = buildNudgePrompt(column.validSentinels);
    const callbacks = this.buildPhaseLoopCallbacks(ticketId, phaseId, column);

    const sbStatus = sandbox.getStatus();
    const controller = new FleetLoopController({
      wsUrl: sbStatus?.type === 'running' ? sbStatus.data.wsUrl : '',
      workspaceDir,
      maxIterations,
      startFromIteration: resumeIteration,
      validSentinels: column.validSentinels,
      buildPrompt: buildPromptFn,
      nudgePrompt,
      ticketTitle: ticket.title,
      callbacks,
    });

    this.loops.set(ticketId, { controller, sandbox });
    this.updatePhaseLoop(ticketId, phaseId, { status: 'running', currentIteration: resumeIteration });
    controller.start();
  };

  // #endregion

  // #region Phase loop callbacks

  private buildPhaseLoopCallbacks = (
    ticketId: FleetTicketId,
    phaseId: FleetPhaseId,
    column: FleetColumn
  ): FleetLoopCallbacks => {
    return {
      onIterationStart: (iteration) => {
        const ticket = this.getTicketById(ticketId);
        const taskId = nanoid();
        const task: FleetTask = {
          id: taskId,
          projectId: ticket?.projectId ?? '',
          taskDescription: ticket?.description || ticket?.title || '',
          status: { type: 'running', timestamp: Date.now(), data: this.getLoopSandboxData(ticketId) },
          createdAt: Date.now(),
          ticketId,
          phaseId,
          columnId: column.id,
          iteration,
        };

        const loopEntry = this.loops.get(ticketId);
        if (loopEntry) {
          this.tasks.set(taskId, { task, sandbox: loopEntry.sandbox });
        }
        this.persistTask(task);
        this.sendToWindow('fleet:task-status', taskId, task.status);

        // Update ticket and phase
        this.updateTicket(ticketId, { taskId: taskId, loopIteration: iteration });
        this.updatePhaseLoop(ticketId, phaseId, { currentIteration: iteration, status: 'running' });

        // Add task to phase's taskIds
        const freshTicket = this.getTicketById(ticketId);
        if (freshTicket) {
          const phases = [...freshTicket.phases];
          const phaseIdx = phases.findIndex((p) => p.id === phaseId);
          if (phaseIdx !== -1) {
            const phase = phases[phaseIdx]!;
            phases[phaseIdx] = { ...phase, taskIds: [...phase.taskIds, taskId] };
            this.updateTicket(ticketId, { phases });
          }
        }

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
      onLoopComplete: (sentinel: FleetSentinel) => {
        this.updatePhaseLoop(ticketId, phaseId, { status: 'completed' });
        const ticket = this.getTicketById(ticketId);

        // Close the phase
        if (ticket) {
          this.closeCurrentPhase(ticket, 'completed', undefined, sentinel);
        }

        this.loops.delete(ticketId);

        // Decision: advance or wait for approval?
        if (column.requiresApproval) {
          // Gate column — stop and wait for human approve/reject
          return;
        }

        // Auto-advance to next column
        setTimeout(() => {
          void this.advanceTicket(ticketId);
        }, 0);
      },
      onLoopError: (error) => {
        console.warn(`Loop error for ticket ${ticketId}: ${error.message}`);
        this.updatePhaseLoop(ticketId, phaseId, { status: 'error' });
        this.loops.delete(ticketId);
      },
      onLoopBlocked: (sentinel: FleetSentinel) => {
        if (sentinel === 'REJECTED') {
          // Auto-kickback to implementation column
          this.updatePhaseLoop(ticketId, phaseId, { status: 'completed' });
          this.loops.delete(ticketId);
          setTimeout(() => {
            void this.kickbackTicket(ticketId, 'implementation');
          }, 0);
          return;
        }

        // BLOCKED or TESTS_FAILING — mark phase as blocked, emit update
        this.updatePhaseLoop(ticketId, phaseId, { status: 'stopped' });
        const ticket = this.getTicketById(ticketId);
        if (ticket) {
          const phases = [...ticket.phases];
          const phaseIdx = phases.findIndex((p) => p.id === phaseId);
          if (phaseIdx !== -1) {
            phases[phaseIdx] = { ...phases[phaseIdx]!, status: 'blocked', exitSentinel: sentinel };
            this.updateTicket(ticketId, { phases });
            this.sendToWindow('fleet:phase-update', ticketId, phases[phaseIdx]!);
          }
        }
      },
      onStatusChange: (status, iteration) => {
        this.updatePhaseLoop(ticketId, phaseId, { status, currentIteration: iteration });
      },
    };
  };

  private createPhaseSandbox = (ticketId: FleetTicketId): SandboxManager => {
    return new SandboxManager({
      ipcLogger: (entry) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          this.sendToWindow('fleet:task-log', currentTaskId, entry);
        }
      },
      ipcRawOutput: (data) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          this.sendToWindow('fleet:task-raw-output', currentTaskId, data);
        }
      },
      onStatusChange: (status) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          const existing = this.tasks.get(currentTaskId);
          if (existing) {
            const patch: Partial<FleetTask> = { status };
            if (status.type === 'running') {
              patch.lastUrls = {
                uiUrl: status.data.uiUrl,
                codeServerUrl: status.data.codeServerUrl,
                noVncUrl: status.data.noVncUrl,
              };
            }
            existing.task = { ...existing.task, ...patch };
            this.persistTask(existing.task);
          }
          this.sendToWindow('fleet:task-status', currentTaskId, status);
        }

        if (status.type === 'running') {
          const loopEntry = this.loops.get(ticketId);
          if (loopEntry && loopEntry.controller.getStatus() === 'idle') {
            loopEntry.controller.wsUrl = status.data.wsUrl;
            loopEntry.controller.start();
          }
        }
      },
    });
  };

  // #endregion

  // #region Checklist CRUD

  updateChecklist = (ticketId: FleetTicketId, columnId: FleetColumnId, checklist: FleetChecklistItem[]): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    this.updateTicket(ticketId, { checklist: { ...ticket.checklist, [columnId]: checklist } });
  };

  toggleChecklistItem = (ticketId: FleetTicketId, columnId: FleetColumnId, itemId: FleetChecklistItemId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    const columnChecklist = ticket.checklist[columnId] ?? [];
    const updated = columnChecklist.map((item) =>
      item.id === itemId ? { ...item, completed: !item.completed } : item
    );
    this.updateTicket(ticketId, { checklist: { ...ticket.checklist, [columnId]: updated } });
  };

  // #endregion

  // #region Legacy backwards compat: submitTicketTask bridges to phase system

  submitTicketTask = async (ticketId: FleetTicketId, options: FleetTaskSubmitOptions): Promise<FleetTask> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    // If loop mode requested and ticket already has a columnId, use new phase system
    if (options.loop && ticket.columnId) {
      return this.submitTicketTaskViaPhase(ticketId, ticket, options);
    }

    // If loop mode requested but no column, place in implementation column first
    if (options.loop && !ticket.columnId) {
      const implColumn = this.getColumn(ticket.projectId, 'implementation');
      if (implColumn) {
        const freshTicket = this.getTicketById(ticketId)!;
        this.createPhase(freshTicket, implColumn);
        return this.submitTicketTaskViaPhase(ticketId, this.getTicketById(ticketId)!, options);
      }
      // Fall through to legacy if no implementation column
    }

    // Non-loop: use legacy path
    if (!options.loop) {
      const task = await this.submitTask(ticket.projectId, ticket.description || ticket.title, options);
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
    }

    // Legacy loop path (fallback)
    return this.submitTicketTaskWithLoop(ticketId, ticket, options);
  };

  /**
   * Bridge: submit ticket task via the new phase system.
   * Creates or reuses the current phase's loop to start work.
   */
  private submitTicketTaskViaPhase = async (
    ticketId: FleetTicketId,
    ticket: FleetTicket,
    options: FleetTaskSubmitOptions
  ): Promise<FleetTask> => {
    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // If ticket needs a worktree, set it up
    let workspaceDir = project.workspaceDir;
    let worktreePath: string | undefined;
    let worktreeName: string | undefined;

    if (options.useWorktree && options.branch) {
      worktreeName = generateWorktreeName();
      worktreePath = await createWorktree(project.workspaceDir, options.branch, worktreeName);
      workspaceDir = worktreePath;
    }

    // Create a placeholder task to return immediately
    const taskId = nanoid();
    const firstTask: FleetTask = {
      id: taskId,
      projectId: ticket.projectId,
      taskDescription: ticket.description || ticket.title,
      status: { type: 'starting', timestamp: Date.now() },
      createdAt: Date.now(),
      branch: options.branch,
      worktreePath,
      worktreeName,
      ticketId,
      phaseId: ticket.currentPhaseId ?? undefined,
      columnId: ticket.columnId ?? undefined,
      iteration: 1,
    };

    // Create sandbox
    const sandbox = this.createPhaseSandbox(ticketId);
    this.tasks.set(taskId, { task: firstTask, sandbox });
    this.persistTask(firstTask);

    this.updateTicket(ticketId, {
      status: 'in_progress',
      taskId,
      loopEnabled: true,
      loopMaxIterations: options.loopMaxIterations ?? 10,
      loopIteration: 1,
      loopStatus: 'running',
    });

    // Start the phase loop
    this.startPhaseWithSandbox(ticketId, sandbox, workspaceDir);

    return firstTask;
  };

  private startPhaseWithSandbox = (ticketId: FleetTicketId, sandbox: SandboxManager, workspaceDir: string): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket || !ticket.columnId || !ticket.currentPhaseId) {
      return;
    }

    const column = this.getColumn(ticket.projectId, ticket.columnId);
    if (!column) {
      return;
    }

    const phaseId = ticket.currentPhaseId;
    const maxIterations = column.maxIterations;

    const buildPromptFn = (iteration: number): string => {
      const freshTicket = this.getTicketById(ticketId);
      return interpolatePromptTemplate(column.promptTemplate, {
        ticket: {
          title: freshTicket?.title ?? ticket.title,
          description: freshTicket?.description ?? ticket.description,
        },
        column: { label: column.label, validSentinels: column.validSentinels },
        checklist: freshTicket?.checklist[column.id] ?? [],
        phaseHistory: freshTicket?.phases.filter((p) => p.id !== phaseId) ?? [],
        iteration,
      });
    };

    const nudgePrompt = buildNudgePrompt(column.validSentinels);
    const callbacks = this.buildPhaseLoopCallbacks(ticketId, phaseId, column);

    const controller = new FleetLoopController({
      wsUrl: '',
      workspaceDir,
      maxIterations,
      validSentinels: column.validSentinels,
      buildPrompt: buildPromptFn,
      nudgePrompt,
      ticketTitle: ticket.title,
      callbacks,
    });

    this.loops.set(ticketId, { controller, sandbox });

    // Update phase to running
    const phases = [...ticket.phases];
    const phaseIdx = phases.findIndex((p) => p.id === phaseId);
    if (phaseIdx !== -1) {
      phases[phaseIdx] = { ...phases[phaseIdx]!, status: 'running' };
      this.updateTicket(ticketId, { phases });
    }

    sandbox.start({ workspaceDir, useWorkDockerfile: true });
  };

  // #endregion

  // #region Legacy loop mode (kept for backwards compat)

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

    const sandbox = new SandboxManager({
      ipcLogger: (entry) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          this.sendToWindow('fleet:task-log', currentTaskId, entry);
        }
      },
      ipcRawOutput: (data) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          this.sendToWindow('fleet:task-raw-output', currentTaskId, data);
        }
      },
      onStatusChange: (status) => {
        const currentTaskId = this.getCurrentLoopTaskId(ticketId);
        if (currentTaskId) {
          const existing = this.tasks.get(currentTaskId);
          if (existing) {
            const patch: Partial<FleetTask> = { status };
            if (status.type === 'running') {
              patch.lastUrls = {
                uiUrl: status.data.uiUrl,
                codeServerUrl: status.data.codeServerUrl,
                noVncUrl: status.data.noVncUrl,
              };
            }
            existing.task = { ...existing.task, ...patch };
            this.persistTask(existing.task);
          }
          this.sendToWindow('fleet:task-status', currentTaskId, status);
        }

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

    const controller = new FleetLoopController({
      wsUrl: '',
      workspaceDir,
      ticketTitle: ticket.title,
      ticketDescription: ticket.description || ticket.title,
      maxIterations,
      callbacks: {
        onIterationStart: (iteration) => {
          if (iteration === 1) {
            return { taskId: firstTaskId };
          }
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

    this.updateTicket(ticketId, {
      status: 'in_progress',
      taskId: firstTaskId,
      loopEnabled: true,
      loopMaxIterations: maxIterations,
      loopIteration: 1,
      loopStatus: 'running',
    });

    sandbox.start({
      workspaceDir,
      useWorkDockerfile: true,
    });

    return firstTask;
  };

  private getCurrentLoopTaskId = (ticketId: FleetTicketId): FleetTaskId | null => {
    const ticket = this.getTicketById(ticketId);
    return ticket?.taskId ?? null;
  };

  private getLoopSandboxData = (
    ticketId: FleetTicketId
  ): Extract<SandboxProcessStatus, { type: 'running' }>['data'] => {
    const loopEntry = this.loops.get(ticketId);
    if (!loopEntry) {
      return {
        sandboxUrl: '',
        wsUrl: '',
        uiUrl: '',
        ports: { sandbox: 0, ui: 0 },
      };
    }
    // Get status directly from the sandbox manager — this is always up-to-date,
    // even before a task has been created for the current iteration.
    const sandboxStatus = loopEntry.sandbox.getStatus();
    if (sandboxStatus.type === 'running') {
      return sandboxStatus.data;
    }
    return {
      sandboxUrl: '',
      wsUrl: '',
      uiUrl: '',
      ports: { sandbox: 0, ui: 0 },
    };
  };

  private stopLoopIfRunning = (ticketId: FleetTicketId): void => {
    const loopEntry = this.loops.get(ticketId);
    if (loopEntry) {
      loopEntry.controller.stop();
      this.loops.delete(ticketId);
    }
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
  };

  resumeLoop = async (ticketId: FleetTicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    // If ticket has phase info, use new phase-based resume
    if (ticket.columnId && ticket.currentPhaseId) {
      return this.resumePhase(ticketId);
    }

    // Legacy resume path
    if (!ticket.loopEnabled) {
      return;
    }

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

    let sandbox: SandboxManager | undefined;
    let workspaceDir = project.workspaceDir;

    if (ticket.taskId) {
      const taskEntry = this.tasks.get(ticket.taskId);
      if (taskEntry) {
        sandbox = taskEntry.sandbox;
        workspaceDir = taskEntry.task.worktreePath ?? project.workspaceDir;
      }
    }

    const sandboxStatus = sandbox?.getStatus();
    if (!sandbox || !sandboxStatus || sandboxStatus.type !== 'running') {
      await this.submitTicketTaskWithLoop(ticketId, ticket, {
        loop: true,
        loopMaxIterations: maxIterations,
      });
      return;
    }

    const controller = new FleetLoopController({
      wsUrl: sandboxStatus.data.wsUrl,
      workspaceDir,
      ticketTitle: ticket.title,
      ticketDescription: ticket.description || ticket.title,
      maxIterations,
      startFromIteration: resumeIteration,
      callbacks: this.buildLegacyLoopCallbacks(ticketId, ticket, sandbox, maxIterations),
    });

    this.loops.set(ticketId, { controller, sandbox });
    this.updateTicket(ticketId, { loopStatus: 'running', loopIteration: resumeIteration });
    controller.start();
  };

  private buildLegacyLoopCallbacks = (
    ticketId: FleetTicketId,
    ticket: FleetTicket,
    sandbox: SandboxManager,
    maxIterations: number
  ): FleetLoopCallbacks => {
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

    // Reset stale running states on tickets — no controllers survive a restart
    this.resetStaleTicketStates();
  };

  /**
   * After a restart, any ticket whose loop/phase was 'running' no longer has a
   * backing controller. Reset those to 'stopped' so the UI shows "Resume" instead
   * of a phantom "Running" spinner.
   */
  private resetStaleTicketStates = (): void => {
    const tickets = this.getTickets();
    let dirty = false;
    const patched = tickets.map((ticket) => {
      let changed = false;
      let t = ticket;

      // Legacy loop status
      if (t.loopStatus === 'running') {
        t = { ...t, loopStatus: 'stopped' };
        changed = true;
      }

      // Phase-based statuses
      const phasesNeedPatch = t.phases.some((p) => p.loop.status === 'running' || p.status === 'running');
      if (phasesNeedPatch) {
        t = {
          ...t,
          phases: t.phases.map((p) => {
            if (p.loop.status !== 'running' && p.status !== 'running') {
              return p;
            }
            return {
              ...p,
              status: p.status === 'running' ? 'pending' : p.status,
              loop: p.loop.status === 'running' ? { ...p.loop, status: 'stopped' } : p.loop,
            };
          }),
        };
        changed = true;
      }

      if (changed) {
        dirty = true;
      }
      return changed ? t : ticket;
    });

    if (dirty) {
      this.setTickets(patched);
    }
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
          const patch: Partial<FleetTask> = { status };
          if (status.type === 'running') {
            patch.lastUrls = {
              uiUrl: status.data.uiUrl,
              codeServerUrl: status.data.codeServerUrl,
              noVncUrl: status.data.noVncUrl,
            };
          }
          existing.task = { ...existing.task, ...patch };
          this.persistTask(existing.task);
        }
        this.sendToWindow('fleet:task-status', taskId, status);

        if (status.type === 'running') {
          void this.initializeTaskSession(taskId, status.data.wsUrl, taskDescription);
        }
      },
    });

    this.tasks.set(taskId, { task, sandbox });
    this.persistTask(task);

    sandbox.start({
      workspaceDir,
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

    if (entry.task.ticketId) {
      const loopEntry = this.loops.get(entry.task.ticketId);
      if (loopEntry) {
        this.stopLoop(entry.task.ticketId);
        this.loops.delete(entry.task.ticketId);
      }
    }

    await entry.sandbox.exit();

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

  // #region Migration

  /**
   * Migrate existing tickets to kanban schema (version 0 → 1).
   * Called once from createFleetManager before manager instantiation.
   */
  static migrateToKanban(store: Store<StoreData>): void {
    const version = store.get('fleetSchemaVersion', 0);
    if (version >= 1) {
      return;
    }

    console.log('[FleetManager] Migrating to kanban schema (v0 → v1)');

    const tickets = store.get('fleetTickets', []) as FleetTicket[];
    const migrated: FleetTicket[] = [];

    for (const ticket of tickets) {
      // Skip if already migrated
      if (ticket.columnId !== undefined && ticket.columnId !== null) {
        migrated.push(ticket);
        continue;
      }

      // Map legacy status to column
      let columnId: FleetColumnId;
      switch (ticket.status) {
        case 'in_progress':
          columnId = 'implementation';
          break;
        case 'completed':
        case 'closed':
          columnId = 'completed';
          break;
        default:
          columnId = 'backlog';
          break;
      }

      // Create synthetic phase from existing loop fields
      const phases: FleetPhase[] = [];
      if (ticket.loopEnabled && ticket.taskId) {
        const syntheticPhase: FleetPhase = {
          id: nanoid(),
          ticketId: ticket.id,
          columnId,
          attempt: 1,
          status:
            ticket.loopStatus === 'running' ? 'running' : ticket.loopStatus === 'completed' ? 'completed' : 'blocked',
          taskIds: [ticket.taskId],
          loop: {
            enabled: true,
            maxIterations: ticket.loopMaxIterations ?? 10,
            currentIteration: ticket.loopIteration ?? 0,
            status: ticket.loopStatus ?? null,
          },
          enteredAt: ticket.createdAt,
          ...(ticket.loopStatus !== 'running' && { exitedAt: ticket.updatedAt }),
        };
        phases.push(syntheticPhase);
      }

      migrated.push({
        ...ticket,
        columnId,
        currentPhaseId:
          phases.length > 0 && phases[phases.length - 1]!.status === 'running' ? phases[phases.length - 1]!.id : null,
        phases,
        checklist: ticket.checklist ?? [],
      });
    }

    store.set('fleetTickets', migrated);
    store.set('fleetSchemaVersion', 1);
    console.log(`[FleetManager] Migration complete: ${migrated.length} tickets migrated`);
  }

  /**
   * Migrate checklist from flat array to per-column record (version 1 → 2).
   */
  static migrateChecklistToRecord(store: Store<StoreData>): void {
    const version = store.get('fleetSchemaVersion', 0);
    if (version >= 2) {
      return;
    }

    console.log('[FleetManager] Migrating checklist to per-column record (v1 → v2)');

    const tickets = store.get('fleetTickets', []) as FleetTicket[];
    const pipeline = DEFAULT_PIPELINE;
    const firstColumnId = pipeline.columns[0]?.id ?? 'backlog';
    const migrated: FleetTicket[] = [];

    for (const ticket of tickets) {
      if (Array.isArray(ticket.checklist)) {
        // Convert old flat array to a record keyed by the ticket's current column or first column
        const targetColumn = ticket.columnId ?? firstColumnId;
        const oldChecklist = ticket.checklist as unknown as FleetChecklistItem[];
        migrated.push({
          ...ticket,
          checklist: oldChecklist.length > 0 ? { [targetColumn]: oldChecklist } : {},
        });
      } else {
        migrated.push(ticket);
      }
    }

    store.set('fleetTickets', migrated);
    store.set('fleetSchemaVersion', 2);
    console.log(`[FleetManager] Checklist migration complete: ${migrated.length} tickets migrated`);
  }

  // #endregion

  // #region Session history

  getSessionHistory = async (sessionId: string): Promise<FleetSessionMessage[]> => {
    const dbPath = path.join(
      app.getPath('home'),
      '.config',
      'omni_code',
      'sandbox',
      'omniagents',
      'sessions',
      'omni_code',
      'omni',
      'sessions.db'
    );

    try {
      await fs.access(dbPath);
    } catch {
      return [];
    }

    const query = `SELECT id, msg_json, created_at FROM history WHERE session_id = '${sessionId.replace(/'/g, "''")}' ORDER BY id ASC`;

    try {
      const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout.trim()) {
        return [];
      }

      const rows = JSON.parse(stdout) as Array<{ id: number; msg_json: string; created_at: string }>;
      const messages: FleetSessionMessage[] = [];

      for (const row of rows) {
        try {
          const msg = JSON.parse(row.msg_json) as Record<string, unknown>;
          const msgType = msg.type as string | undefined;
          const role = msg.role as string | undefined;

          // Skip reasoning blocks (encrypted, not useful)
          if (msgType === 'reasoning') {
            continue;
          }

          if (role === 'user') {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            messages.push({
              id: row.id,
              role: 'user',
              content: content.slice(0, 50_000),
              createdAt: row.created_at,
            });
          } else if (role === 'assistant' && msgType === 'message') {
            const contentBlocks = msg.content as Array<{ type: string; text?: string }> | undefined;
            const text = Array.isArray(contentBlocks)
              ? contentBlocks
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text)
                  .join('\n')
              : '';
            if (text) {
              messages.push({
                id: row.id,
                role: 'assistant',
                content: text.slice(0, 50_000),
                createdAt: row.created_at,
              });
            }
          } else if (msgType === 'function_call') {
            const name = (msg.name as string) || 'unknown_tool';
            const args = typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? '');
            messages.push({
              id: row.id,
              role: 'tool_call',
              content: args.slice(0, 2000),
              toolName: name,
              createdAt: row.created_at,
            });
          } else if (msgType === 'function_call_output') {
            const output = typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? '');
            messages.push({
              id: row.id,
              role: 'tool_result',
              content: output.slice(0, 5000),
              createdAt: row.created_at,
            });
          }
        } catch {
          // Skip unparseable messages
        }
      }

      return messages;
    } catch (err) {
      console.error('[FleetManager] Failed to query session history:', err);
      return [];
    }
  };

  // #endregion

  exit = async (): Promise<void> => {
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

  // Run migrations before creating the manager
  FleetManager.migrateToKanban(store);
  FleetManager.migrateChecklistToRecord(store);

  const fleetManager = new FleetManager({ store, sendToWindow });
  fleetManager.restorePersistedTasks();

  // Existing IPC handlers
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

  // Phase 2: New IPC handlers
  ipc.handle('fleet:advance-ticket', (_, ticketId) => fleetManager.advanceTicket(ticketId));
  ipc.handle('fleet:move-ticket-to-column', (_, ticketId, columnId) =>
    fleetManager.moveTicketToColumn(ticketId, columnId)
  );
  ipc.handle('fleet:kickback-ticket', (_, ticketId, targetColumnId, reviewNote) =>
    fleetManager.kickbackTicket(ticketId, targetColumnId, reviewNote)
  );
  ipc.handle('fleet:approve-phase', (_, ticketId, reviewNote) => fleetManager.approvePhase(ticketId, reviewNote));
  ipc.handle('fleet:reject-phase', (_, ticketId, reviewNote) => fleetManager.rejectPhase(ticketId, reviewNote));
  ipc.handle('fleet:start-phase', (_, ticketId) => fleetManager.startPhase(ticketId));
  ipc.handle('fleet:stop-phase', (_, ticketId) => fleetManager.stopPhase(ticketId));
  ipc.handle('fleet:resume-phase', (_, ticketId) => fleetManager.resumePhase(ticketId));
  ipc.handle('fleet:update-checklist', (_, ticketId, columnId, checklist) =>
    fleetManager.updateChecklist(ticketId, columnId, checklist)
  );
  ipc.handle('fleet:toggle-checklist-item', (_, ticketId, columnId, itemId) =>
    fleetManager.toggleChecklistItem(ticketId, columnId, itemId)
  );
  ipc.handle('fleet:get-pipeline', (_, projectId) => fleetManager.getPipeline(projectId));
  ipc.handle('fleet:get-session-history', (_, sessionId) => fleetManager.getSessionHistory(sessionId));

  const cleanup = async () => {
    await fleetManager.exit();
    // Existing handlers
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
    // Phase 2 handlers
    ipcMain.removeHandler('fleet:advance-ticket');
    ipcMain.removeHandler('fleet:move-ticket-to-column');
    ipcMain.removeHandler('fleet:kickback-ticket');
    ipcMain.removeHandler('fleet:approve-phase');
    ipcMain.removeHandler('fleet:reject-phase');
    ipcMain.removeHandler('fleet:start-phase');
    ipcMain.removeHandler('fleet:stop-phase');
    ipcMain.removeHandler('fleet:resume-phase');
    ipcMain.removeHandler('fleet:update-checklist');
    ipcMain.removeHandler('fleet:toggle-checklist-item');
    ipcMain.removeHandler('fleet:get-pipeline');
    ipcMain.removeHandler('fleet:get-session-history');
  };

  return [fleetManager, cleanup] as const;
};
