import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { execFile } from 'child_process';
import { ipcMain, shell } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import { getArtifactsDir, getContainerArtifactsDir, getContainerPlanPath } from '@/lib/fleet-plan-file';
import { getMimeType, isTextMime } from '@/lib/mime-types';
import { FleetPlanSync } from '@/main/fleet-plan-sync';
import { FleetSupervisor } from '@/main/fleet-supervisor';
import { buildSupervisorPrompt } from '@/main/fleet-supervisor-prompt';
import { SandboxManager } from '@/main/sandbox-manager';
import { getOmniConfigDir, getWorktreesDir } from '@/main/util';
import { DEFAULT_PIPELINE } from '@/shared/fleet-defaults';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  DiffResponse,
  FileDiff,
  FleetChecklistItem,
  FleetChecklistItemId,
  FleetColumnId,
  FleetPipeline,
  FleetProject,
  FleetProjectId,
  FleetSessionMessage,
  FleetSupervisorStatus,
  FleetTask,
  FleetTaskId,
  FleetTicket,
  FleetTicketId,
  FleetTicketPriority,
  GitRepoInfo,
  IpcEvents,
  IpcRendererEvents,
  StoreData,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

// #region JSON-RPC helper

const SAFE_TOOL_OVERRIDES = { safe_tool_patterns: ['.*'] };

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
          params: { prompt, safe_tool_overrides: SAFE_TOOL_OVERRIDES },
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

export class FleetManager {
  private tasks = new Map<FleetTaskId, { task: FleetTask; sandbox: SandboxManager }>();
  private supervisors = new Map<FleetTicketId, { supervisor: FleetSupervisor; sandbox: SandboxManager }>();
  private store: Store<StoreData>;
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  private planSync: FleetPlanSync;

  constructor(arg: { store: Store<StoreData>; sendToWindow: FleetManager['sendToWindow'] }) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.planSync = new FleetPlanSync();
  }

  // #region Plan file sync

  /** Write PLAN.md to disk for a ticket (fire-and-forget). */
  private syncPlanFile = (ticketId: FleetTicketId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    const pipeline = this.getPipeline(ticket.projectId);
    void this.planSync.writePlan(ticket, pipeline);
  };

  /** Start watching a ticket's PLAN.md and apply external changes to the store. */
  private startPlanWatcher = (ticketId: FleetTicketId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    const pipeline = this.getPipeline(ticket.projectId);

    this.planSync.watchTicket(
      ticketId,
      (event) => {
        const freshTicket = this.getTicketById(ticketId);
        if (!freshTicket) {
          return;
        }

        // Diff each column and only update if changed
        for (const [columnId, items] of Object.entries(event.checklist)) {
          const existing = freshTicket.checklist[columnId] ?? [];

          // Quick check: did completion states change?
          const changed =
            existing.length !== items.length ||
            existing.some((e, i) => {
              const parsed = items[i];
              return parsed && (e.completed !== parsed.completed || e.text !== parsed.text);
            });

          if (changed) {
            // Merge: preserve existing IDs where text matches, use parsed completion state
            const merged = items.map((parsedItem, idx) => {
              const existingItem = existing[idx];
              return {
                id: existingItem?.text === parsedItem.text ? existingItem.id : parsedItem.id,
                text: parsedItem.text,
                completed: parsedItem.completed,
              };
            });
            this.updateChecklist(ticketId, columnId, merged);
          }
        }

        // Handle column change from frontmatter
        if (event.column) {
          const labelToId = new Map<string, string>();
          for (const col of pipeline.columns) {
            labelToId.set(col.label.trim().toLowerCase(), col.id);
          }
          const newColumnId = labelToId.get(event.column.trim().toLowerCase());
          if (newColumnId && newColumnId !== freshTicket.columnId) {
            this.moveTicketToColumn(ticketId, newColumnId);
          }
        }
      },
      pipeline
    );
  };

  private stopPlanWatcher = (ticketId: FleetTicketId): void => {
    this.planSync.unwatchTicket(ticketId);
  };

  // #endregion

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

  private getColumn = (projectId: FleetProjectId, columnId: FleetColumnId) => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns.find((c) => c.id === columnId);
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

  addTicket = (input: Omit<FleetTicket, 'id' | 'createdAt' | 'updatedAt' | 'columnId' | 'checklist'>): FleetTicket => {
    const now = Date.now();
    const ticket: FleetTicket = {
      ...input,
      id: nanoid(),
      columnId: 'backlog',
      checklist: {},
      createdAt: now,
      updatedAt: now,
    };
    const tickets = this.getTickets();
    tickets.push(ticket);
    this.setTickets(tickets);
    this.syncPlanFile(ticket.id);
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
    // Stop supervisor if running
    const supervisorEntry = this.supervisors.get(id);
    if (supervisorEntry) {
      void supervisorEntry.supervisor.dispose();
      void supervisorEntry.sandbox.exit();
      this.supervisors.delete(id);
    }

    const tickets = this.getTickets().filter((t) => t.id !== id);
    this.setTickets(tickets);
    void this.planSync.removePlan(id);
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
        // A ticket is blocked if the blocker is not in the completed column
        return blocker && blocker.columnId !== 'completed';
      });
    };

    const candidates = tickets.filter((t) => t.columnId === 'backlog' && !isBlocked(t));
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

  // #region Artifacts

  private getArtifactsRoot = (ticketId: FleetTicketId): string => {
    const configDir = getOmniConfigDir();
    return getArtifactsDir(configDir, ticketId);
  };

  private validateArtifactPath = (ticketId: FleetTicketId, relativePath: string): string => {
    const root = this.getArtifactsRoot(ticketId);
    const fullPath = path.resolve(root, relativePath);
    if (!fullPath.startsWith(root)) {
      throw new Error('Path traversal detected');
    }
    return fullPath;
  };

  listArtifacts = async (ticketId: FleetTicketId, dirPath?: string): Promise<ArtifactFileEntry[]> => {
    const root = this.getArtifactsRoot(ticketId);
    const targetDir = dirPath ? this.validateArtifactPath(ticketId, dirPath) : root;

    try {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const results: ArtifactFileEntry[] = [];

      for (const entry of entries) {
        const relPath = dirPath ? path.join(dirPath, entry.name) : entry.name;
        const fullPath = path.join(targetDir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          results.push({
            relativePath: relPath,
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
          });
        } catch {
          // Skip entries we can't stat
        }
      }

      // Sort: directories first, then alphabetical
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return results;
    } catch {
      return [];
    }
  };

  readArtifact = async (ticketId: FleetTicketId, relativePath: string): Promise<ArtifactFileContent> => {
    const fullPath = this.validateArtifactPath(ticketId, relativePath);
    const stat = await fs.stat(fullPath);
    const mimeType = getMimeType(relativePath);

    if (isTextMime(mimeType) && stat.size <= 512_000) {
      const textContent = await fs.readFile(fullPath, 'utf-8');
      return { relativePath, mimeType, textContent, size: stat.size };
    }

    return { relativePath, mimeType, textContent: null, size: stat.size };
  };

  openArtifactExternal = async (ticketId: FleetTicketId, relativePath: string): Promise<void> => {
    const fullPath = this.validateArtifactPath(ticketId, relativePath);
    await shell.openPath(fullPath);
  };

  // #endregion

  // #region Files changed (git diff)

  getFilesChanged = async (ticketId: FleetTicketId): Promise<DiffResponse> => {
    const empty: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };

    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return empty;
    }

    // Find the task associated with this ticket (via supervisorTaskId or ticketId on task)
    let task: FleetTask | undefined;
    if (ticket.supervisorTaskId) {
      task = this.tasks.get(ticket.supervisorTaskId)?.task;
    }
    if (!task) {
      // Fallback: search all tasks for one matching this ticketId
      for (const [, entry] of this.tasks) {
        if (entry.task.ticketId === ticketId) {
          task = entry.task;
          break;
        }
      }
    }
    if (!task) {
      // Also check persisted tasks in the store
      const storedTasks = this.store.get('fleetTasks') ?? [];
      task = storedTasks.find((t) => t.ticketId === ticketId);
    }

    // Determine the git directory and merge base reference.
    // Case 1: task has a worktree → diff worktree against its base branch
    // Case 2: no worktree (supervisor mode) → diff project workspaceDir against upstream tracking branch
    let gitDir: string;
    let mergeBase: string;

    if (task?.worktreePath && task.branch) {
      gitDir = task.worktreePath;
      try {
        await fs.access(gitDir);
      } catch {
        return empty;
      }
      try {
        const { stdout } = await execFileAsync('git', ['-C', gitDir, 'merge-base', task.branch, 'HEAD'], {
          timeout: 10_000,
        });
        mergeBase = stdout.trim();
      } catch {
        mergeBase = task.branch;
      }
    } else {
      // Supervisor mode: no worktree, diff the project workspace against its upstream
      const project = this.getProjects().find((p) => p.id === ticket.projectId);
      if (!project) {
        return empty;
      }
      gitDir = project.workspaceDir;
      try {
        await fs.access(gitDir);
      } catch {
        return empty;
      }
      // Try to find the upstream tracking branch as the base ref
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', gitDir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          { timeout: 10_000 }
        );
        const upstream = stdout.trim();
        if (upstream && upstream !== '@{upstream}') {
          // Use merge-base between upstream and HEAD
          try {
            const { stdout: mb } = await execFileAsync('git', ['-C', gitDir, 'merge-base', upstream, 'HEAD'], {
              timeout: 10_000,
            });
            mergeBase = mb.trim();
          } catch {
            mergeBase = upstream;
          }
        } else {
          // No upstream, diff against HEAD (show uncommitted changes only)
          mergeBase = 'HEAD';
        }
      } catch {
        // No upstream tracking branch — show all uncommitted + staged changes
        mergeBase = 'HEAD';
      }
    }

    try {
      // Only show committed changes (HEAD vs merge-base), not unstaged/untracked work
      const { stdout: diffOutput } = await execFileAsync(
        'git',
        ['-C', gitDir, 'diff', '--name-status', '-M', '-C', mergeBase, 'HEAD'],
        { timeout: 10_000 }
      );

      const files: FileDiff[] = [];

      for (const line of diffOutput.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        const parts = line.split('\t');
        const statusChar = parts[0]?.charAt(0);
        const filePath = parts[parts.length === 3 ? 2 : 1] ?? '';
        const oldPath = parts.length === 3 ? parts[1] : undefined;

        let status: FileDiff['status'];
        switch (statusChar) {
          case 'A':
            status = 'added';
            break;
          case 'M':
            status = 'modified';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'renamed';
            break;
          case 'C':
            status = 'copied';
            break;
          default:
            status = 'modified';
        }

        files.push({ path: filePath, oldPath, status, additions: 0, deletions: 0, isBinary: false });
      }

      // Get per-file patches and stats
      let totalAdditions = 0;
      let totalDeletions = 0;

      for (const file of files) {
        try {
          const { stdout: patch } = await execFileAsync(
            'git',
            ['-C', gitDir, 'diff', '--unified=8', '--inter-hunk-context=4', mergeBase, 'HEAD', '--', file.path],
            { timeout: 5_000 }
          );
          file.patch = patch;

          // Count additions/deletions from the patch
          if (file.patch) {
            for (const patchLine of file.patch.split('\n')) {
              if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
                file.additions++;
              } else if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
                file.deletions++;
              }
            }
          }

          // Detect binary
          if (file.patch?.includes('Binary files')) {
            file.isBinary = true;
            file.patch = undefined;
          }

          totalAdditions += file.additions;
          totalDeletions += file.deletions;
        } catch {
          // If we can't get the patch for a file, just skip it
        }
      }

      return {
        totalFiles: files.length,
        totalAdditions,
        totalDeletions,
        hasChanges: files.length > 0,
        files,
      };
    } catch {
      return empty;
    }
  };

  // #endregion

  // #region Column movement

  moveTicketToColumn = (ticketId: FleetTicketId, columnId: FleetColumnId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const column = this.getColumn(ticket.projectId, columnId);
    if (!column) {
      return;
    }

    // Seed checklist from column defaults if this column key doesn't exist yet
    let checklist = ticket.checklist;
    if (!(columnId in checklist) && column.defaultChecklist.length > 0) {
      checklist = {
        ...checklist,
        [columnId]: column.defaultChecklist.map((item) => ({ ...item, id: `chk-${nanoid()}` })),
      };
    }

    this.updateTicket(ticketId, { columnId, checklist });
    this.syncPlanFile(ticketId);
  };

  // #endregion

  // #region Checklist CRUD

  updateChecklist = (ticketId: FleetTicketId, columnId: FleetColumnId, checklist: FleetChecklistItem[]): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }
    this.updateTicket(ticketId, { checklist: { ...ticket.checklist, [columnId]: checklist } });
    this.syncPlanFile(ticketId);
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
    this.syncPlanFile(ticketId);
  };

  // #endregion

  // #region Supervisor lifecycle

  /**
   * Ensure sandbox + supervisor infrastructure exists for a ticket.
   * Does NOT send any prompt — just gets the sandbox running and supervisor wired up.
   * When the sandbox becomes ready, fires onReady with the wsUrl.
   */
  ensureSupervisorInfra = async (
    ticketId: FleetTicketId,
    onReady?: (wsUrl: string) => void
  ): Promise<{ supervisor: FleetSupervisor; sandbox: SandboxManager }> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // Stop existing supervisor if any
    const existing = this.supervisors.get(ticketId);
    if (existing) {
      await existing.supervisor.dispose();
      const sbStatus = existing.sandbox.getStatus();
      if (sbStatus?.type !== 'running') {
        await existing.sandbox.exit();
        this.supervisors.delete(ticketId);
      }
    }

    this.updateTicket(ticketId, { supervisorStatus: 'running' });
    this.sendToWindow('fleet:supervisor-status', ticketId, 'running');

    // Create or reuse sandbox
    let sandbox: SandboxManager;
    let supervisorEntry = this.supervisors.get(ticketId);
    let workspaceDir = project.workspaceDir;

    if (supervisorEntry) {
      sandbox = supervisorEntry.sandbox;
    } else {
      const taskId = nanoid();

      // Create worktree if configured on the ticket
      let worktreePath: string | undefined;
      let worktreeName: string | undefined;

      if (ticket.useWorktree && ticket.branch) {
        worktreeName = generateWorktreeName();
        worktreePath = await createWorktree(project.workspaceDir, ticket.branch, worktreeName);
        workspaceDir = worktreePath;
      }

      const task: FleetTask = {
        id: taskId,
        projectId: ticket.projectId,
        taskDescription: `Supervisor for: ${ticket.title}`,
        status: { type: 'starting', timestamp: Date.now() },
        createdAt: Date.now(),
        ticketId,
        branch: ticket.branch,
        worktreePath,
        worktreeName,
      };

      let readyFired = false;

      sandbox = new SandboxManager({
        ipcLogger: () => {},
        ipcRawOutput: () => {},
        onStatusChange: (status) => {
          const taskEntry = this.tasks.get(taskId);
          if (taskEntry) {
            const patch: Partial<FleetTask> = { status };
            if (status.type === 'running') {
              patch.lastUrls = {
                uiUrl: status.data.uiUrl,
                codeServerUrl: status.data.codeServerUrl,
                noVncUrl: status.data.noVncUrl,
              };
            }
            taskEntry.task = { ...taskEntry.task, ...patch };
            this.persistTask(taskEntry.task);
          }
          this.sendToWindow('fleet:task-status', taskId, status);

          if (status.type === 'running' && !readyFired) {
            readyFired = true;
            const entry = this.supervisors.get(ticketId);
            if (entry) {
              entry.supervisor.setWsUrl(status.data.wsUrl);
              void this.ensureSession(ticketId).then(() => onReady?.(status.data.wsUrl));
            }
          }
        },
      });

      this.tasks.set(taskId, { task, sandbox });
      this.persistTask(task);
      this.updateTicket(ticketId, { supervisorTaskId: taskId });
    }

    // Create supervisor
    const supervisor = new FleetSupervisor({
      wsUrl: '',
      onStatusChange: (status: FleetSupervisorStatus) => {
        this.updateTicket(ticketId, { supervisorStatus: status });
        this.sendToWindow('fleet:supervisor-status', ticketId, status);
      },
      onMessage: (msg: FleetSessionMessage) => {
        this.sendToWindow('fleet:supervisor-message', ticketId, msg);
      },
      onRunEnd: (reason: string) => {
        console.log(`[FleetManager] Supervisor run ended for ${ticketId}: ${reason}`);
      },
    });

    this.supervisors.set(ticketId, { supervisor, sandbox });

    this.syncPlanFile(ticketId);
    this.startPlanWatcher(ticketId);

    // Start sandbox if not already running
    if (!supervisorEntry) {
      sandbox.start({ workspaceDir, sandboxVariant: 'work' });
    } else {
      // Already running — ensure session exists, then fire onReady
      const sbStatus = sandbox.getStatus();
      if (sbStatus?.type === 'running') {
        supervisor.setWsUrl(sbStatus.data.wsUrl);
        void this.ensureSession(ticketId).then(() => onReady?.(sbStatus.data.wsUrl));
      }
    }

    return { supervisor, sandbox };
  };

  /**
   * Ensure a session exists for the ticket. If no supervisorSessionId is set,
   * calls session.ensure via RPC to create one with variables and persists it.
   */
  private ensureSession = async (ticketId: FleetTicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    // Already have a session — just make sure the supervisor knows about it
    if (ticket.supervisorSessionId) {
      const entry = this.supervisors.get(ticketId);
      if (entry && !entry.supervisor.getSessionId()) {
        // Supervisor instance was recreated but ticket has a session — restore it
        // We can't restore directly, so create a new session
      } else {
        return;
      }
    }

    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      return;
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return;
    }

    const pipeline = this.getPipeline(ticket.projectId);
    const supervisorPrompt = buildSupervisorPrompt(ticket, project, pipeline);
    const variables = { additional_instructions: supervisorPrompt };

    try {
      console.log(`[FleetManager] Creating session for ticket ${ticketId} with variables:`, Object.keys(variables));
      const sessionId = await entry.supervisor.createSession(variables);
      console.log(`[FleetManager] Session created: ${sessionId} for ticket ${ticketId}`);
      this.updateTicket(ticketId, { supervisorSessionId: sessionId, supervisorStatus: 'idle' });
      this.sendToWindow('fleet:supervisor-status', ticketId, 'idle');
    } catch (error) {
      console.error(`[FleetManager] Failed to create session for ${ticketId}:`, error);
    }
  };

  /**
   * Start the autonomous supervisor — sends the full supervisor prompt as the user turn.
   * Triggered by the Play button.
   */
  startSupervisor = async (ticketId: FleetTicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId)!;
    const project = this.getProjects().find((p) => p.id === ticket.projectId)!;
    const pipeline = this.getPipeline(ticket.projectId);
    const supervisorPrompt = buildSupervisorPrompt(ticket, project, pipeline);
    const sessionId = ticket.supervisorSessionId;
    const variables = { additional_instructions: supervisorPrompt };

    await this.ensureSupervisorInfra(ticketId, () => {
      this.startSupervisorRun(ticketId, 'Begin working on this ticket.', { sessionId, variables });
    });
  };

  private startSupervisorRun = (
    ticketId: FleetTicketId,
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): void => {
    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      return;
    }

    void entry.supervisor.startRun(prompt, { sessionId: opts?.sessionId, variables: opts?.variables }).then(
      (result) => {
        this.updateTicket(ticketId, {
          supervisorSessionId: result.sessionId,
        });
      },
      (error) => {
        console.error(`[FleetManager] Supervisor start failed for ${ticketId}:`, error);
        this.updateTicket(ticketId, { supervisorStatus: 'error' });
        this.sendToWindow('fleet:supervisor-status', ticketId, 'error');
      }
    );
  };

  stopSupervisor = async (ticketId: FleetTicketId): Promise<void> => {
    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      return;
    }

    await entry.supervisor.stop();
    this.stopPlanWatcher(ticketId);
    this.updateTicket(ticketId, { supervisorStatus: 'idle' });
    this.sendToWindow('fleet:supervisor-status', ticketId, 'idle');
  };

  resetSupervisorSession = async (ticketId: FleetTicketId): Promise<void> => {
    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      return;
    }

    // Stop current run if active
    await entry.supervisor.stop();

    // Build fresh variables
    const ticket = this.getTicketById(ticketId)!;
    const project = this.getProjects().find((p) => p.id === ticket.projectId)!;
    const pipeline = this.getPipeline(ticket.projectId);
    const supervisorPrompt = buildSupervisorPrompt(ticket, project, pipeline);
    const variables = { additional_instructions: supervisorPrompt };

    // Ensure WS is connected
    const sbStatus = entry.sandbox.getStatus();
    if (sbStatus?.type === 'running') {
      entry.supervisor.setWsUrl(sbStatus.data.wsUrl);
    }

    // Create a new session with variables (no user message sent)
    const newSessionId = await entry.supervisor.createSession(variables);
    this.updateTicket(ticketId, {
      supervisorSessionId: newSessionId,
      supervisorStatus: 'idle',
    });
    this.sendToWindow('fleet:supervisor-status', ticketId, 'idle');
  };

  sendSupervisorMessage = async (ticketId: FleetTicketId, message: string): Promise<void> => {
    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      // No active supervisor — spin up sandbox, then send the user's message
      // as the prompt with ticket context as system instructions
      await this.ensureSupervisorInfra(ticketId, () => {
        // Sandbox is ready — send the user's message now
        void this.sendUserRunMessage(ticketId, message);
      });
      return;
    }

    const status = entry.supervisor.getStatus();

    if (status === 'idle' || status === 'error') {
      await this.sendUserRunMessage(ticketId, message);
    } else if (status === 'running') {
      // Inject message into running session
      try {
        await entry.supervisor.sendMessage(message);
      } catch (error) {
        console.error(`[FleetManager] Supervisor send_user_message failed for ${ticketId}:`, error);
      }
    }
  };

  /**
   * Start a run with the user's message as the prompt.
   * On the first message (no existing session), ticket context is prepended.
   * On follow-ups (existing session), just the user's message is sent since the
   * agent already has context from the conversation history.
   */
  private sendUserRunMessage = async (ticketId: FleetTicketId, message: string): Promise<void> => {
    const entry = this.supervisors.get(ticketId);
    if (!entry) {
      return;
    }

    this.updateTicket(ticketId, { supervisorStatus: 'running' });
    this.sendToWindow('fleet:supervisor-status', ticketId, 'running');

    const sbStatus = entry.sandbox.getStatus();
    if (sbStatus?.type === 'running') {
      entry.supervisor.setWsUrl(sbStatus.data.wsUrl);
    }

    const sessionId = entry.supervisor.getSessionId() ?? undefined;

    // Always pass fresh ticket context via variables so instructions stay current
    let variables: Record<string, unknown> | undefined;
    const ticket = this.getTicketById(ticketId);
    const project = ticket ? this.getProjects().find((p) => p.id === ticket.projectId) : undefined;
    if (ticket && project) {
      const supervisorPrompt = buildSupervisorPrompt(ticket, project, this.getPipeline(ticket.projectId));
      variables = { additional_instructions: supervisorPrompt };
    }

    try {
      await entry.supervisor.startRun(message, { sessionId, variables });
      const sid = entry.supervisor.getSessionId();
      if (sid) {
        this.updateTicket(ticketId, { supervisorSessionId: sid });
      }
    } catch (error) {
      console.error(`[FleetManager] Supervisor message failed for ${ticketId}:`, error);
    }
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

    // Reset stale supervisor states on tickets
    this.resetStaleTicketStates();
  };

  private resetStaleTicketStates = (): void => {
    const tickets = this.getTickets();
    let dirty = false;
    const patched = tickets.map((ticket) => {
      if (ticket.supervisorStatus === 'running') {
        dirty = true;
        return { ...ticket, supervisorStatus: 'idle' as const };
      }
      return ticket;
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

  private stopTask = async (taskId: FleetTaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }

    // If this task belongs to a supervisor, stop the supervisor too
    if (entry.task.ticketId) {
      const supervisorEntry = this.supervisors.get(entry.task.ticketId);
      if (supervisorEntry) {
        await this.stopSupervisor(entry.task.ticketId);
      }
    }

    await entry.sandbox.stop();
  };

  private removeTask = async (taskId: FleetTaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }

    // If this task belongs to a supervisor, clean up the supervisor
    if (entry.task.ticketId) {
      const supervisorEntry = this.supervisors.get(entry.task.ticketId);
      if (supervisorEntry) {
        await supervisorEntry.supervisor.dispose();
        this.supervisors.delete(entry.task.ticketId);
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
   * Migrate existing tickets to supervisor schema (version 2 → 3).
   * Strips legacy phase/loop fields and normalizes to new structure.
   */
  static migrateToSupervisor(store: Store<StoreData>): void {
    const version = store.get('fleetSchemaVersion', 0);
    if (version >= 3) {
      return;
    }

    console.log('[FleetManager] Migrating to supervisor schema (→ v3)');

    const tickets = store.get('fleetTickets', []) as Record<string, unknown>[];
    const migrated: FleetTicket[] = [];

    for (const raw of tickets) {
      // Strip all legacy fields and normalize
      const ticket: FleetTicket = {
        id: (raw.id as string) ?? nanoid(),
        projectId: (raw.projectId as string) ?? '',
        title: (raw.title as string) ?? '',
        description: (raw.description as string) ?? '',
        priority: (raw.priority as FleetTicketPriority) ?? 'medium',
        blockedBy: (raw.blockedBy as FleetTicketId[]) ?? [],
        createdAt: (raw.createdAt as number) ?? Date.now(),
        updatedAt: (raw.updatedAt as number) ?? Date.now(),
        columnId: (raw.columnId as FleetColumnId) ?? 'backlog',
        checklist: (raw.checklist as Record<FleetColumnId, FleetChecklistItem[]>) ?? {},
      };

      // Handle legacy checklist format (array → record)
      if (Array.isArray(ticket.checklist)) {
        const targetColumn = ticket.columnId;
        const oldChecklist = ticket.checklist as unknown as FleetChecklistItem[];
        ticket.checklist = oldChecklist.length > 0 ? { [targetColumn]: oldChecklist } : {};
      }

      // Map legacy status to columnId if not set
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

    store.set('fleetTickets', migrated);
    store.set('fleetSchemaVersion', 3);
    console.log(`[FleetManager] Migration complete: ${migrated.length} tickets migrated`);
  }

  // #endregion

  // #region Session history

  getSessionHistory = async (sessionId: string): Promise<FleetSessionMessage[]> => {
    const dbPath = path.join(
      getOmniConfigDir(),
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
    this.planSync.dispose();

    // Dispose all supervisors
    for (const [ticketId, entry] of this.supervisors) {
      await entry.supervisor.dispose();
      this.supervisors.delete(ticketId);
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

  // Run migration
  FleetManager.migrateToSupervisor(store);

  const fleetManager = new FleetManager({ store, sendToWindow });
  fleetManager.restorePersistedTasks();

  // Project handlers
  ipc.handle('fleet:add-project', (_, project) => fleetManager.addProject(project));
  ipc.handle('fleet:update-project', (_, id, patch) => fleetManager.updateProject(id, patch));
  ipc.handle('fleet:remove-project', (_, id) => fleetManager.removeProject(id));
  ipc.handle('fleet:check-git-repo', (_, workspaceDir) => checkGitRepo(workspaceDir));

  // Ticket handlers
  ipc.handle('fleet:add-ticket', (_, ticket) => fleetManager.addTicket(ticket));
  ipc.handle('fleet:update-ticket', (_, id, patch) => fleetManager.updateTicket(id, patch));
  ipc.handle('fleet:remove-ticket', (_, id) => fleetManager.removeTicket(id));
  ipc.handle('fleet:get-tickets', (_, projectId) => fleetManager.getTicketsByProject(projectId));
  ipc.handle('fleet:get-next-ticket', (_, projectId) => fleetManager.getNextTicket(projectId));

  // Kanban & checklist
  ipc.handle('fleet:move-ticket-to-column', (_, ticketId, columnId) =>
    fleetManager.moveTicketToColumn(ticketId, columnId)
  );
  ipc.handle('fleet:update-checklist', (_, ticketId, columnId, checklist) =>
    fleetManager.updateChecklist(ticketId, columnId, checklist)
  );
  ipc.handle('fleet:toggle-checklist-item', (_, ticketId, columnId, itemId) =>
    fleetManager.toggleChecklistItem(ticketId, columnId, itemId)
  );
  ipc.handle('fleet:get-pipeline', (_, projectId) => fleetManager.getPipeline(projectId));

  // Session history
  ipc.handle('fleet:get-session-history', (_, sessionId) => fleetManager.getSessionHistory(sessionId));

  // Artifacts
  ipc.handle('fleet:list-artifacts', (_, ticketId, dirPath) => fleetManager.listArtifacts(ticketId, dirPath));
  ipc.handle('fleet:read-artifact', (_, ticketId, relativePath) => fleetManager.readArtifact(ticketId, relativePath));
  ipc.handle('fleet:open-artifact-external', (_, ticketId, relativePath) =>
    fleetManager.openArtifactExternal(ticketId, relativePath)
  );
  ipc.handle('fleet:get-files-changed', (_, ticketId) => fleetManager.getFilesChanged(ticketId));

  // Supervisor handlers
  ipc.handle('fleet:ensure-supervisor-infra', async (_, ticketId) => {
    await fleetManager.ensureSupervisorInfra(ticketId);
  });
  ipc.handle('fleet:start-supervisor', (_, ticketId) => fleetManager.startSupervisor(ticketId));
  ipc.handle('fleet:stop-supervisor', (_, ticketId) => fleetManager.stopSupervisor(ticketId));
  ipc.handle('fleet:send-supervisor-message', (_, ticketId, message) =>
    fleetManager.sendSupervisorMessage(ticketId, message)
  );
  ipc.handle('fleet:reset-supervisor-session', (_, ticketId) => fleetManager.resetSupervisorSession(ticketId));

  const cleanup = async () => {
    await fleetManager.exit();
    ipcMain.removeHandler('fleet:add-project');
    ipcMain.removeHandler('fleet:update-project');
    ipcMain.removeHandler('fleet:remove-project');
    ipcMain.removeHandler('fleet:check-git-repo');
    ipcMain.removeHandler('fleet:add-ticket');
    ipcMain.removeHandler('fleet:update-ticket');
    ipcMain.removeHandler('fleet:remove-ticket');
    ipcMain.removeHandler('fleet:get-tickets');
    ipcMain.removeHandler('fleet:get-next-ticket');
    ipcMain.removeHandler('fleet:move-ticket-to-column');
    ipcMain.removeHandler('fleet:update-checklist');
    ipcMain.removeHandler('fleet:toggle-checklist-item');
    ipcMain.removeHandler('fleet:get-pipeline');
    ipcMain.removeHandler('fleet:get-session-history');
    ipcMain.removeHandler('fleet:list-artifacts');
    ipcMain.removeHandler('fleet:read-artifact');
    ipcMain.removeHandler('fleet:open-artifact-external');
    ipcMain.removeHandler('fleet:get-files-changed');
    ipcMain.removeHandler('fleet:ensure-supervisor-infra');
    ipcMain.removeHandler('fleet:start-supervisor');
    ipcMain.removeHandler('fleet:stop-supervisor');
    ipcMain.removeHandler('fleet:send-supervisor-message');
    ipcMain.removeHandler('fleet:reset-supervisor-session');
  };

  return [fleetManager, cleanup] as const;
};
