import type { IpcListener } from '@electron-toolkit/typed-ipc/main';
import { execFile } from 'child_process';
import { ipcMain, shell } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import path from 'path';
import { promisify } from 'util';

import { buildAutopilotVariables, buildInteractiveVariables } from '@/lib/client-tools';
import { isExpired, INBOX_SWEEP_INTERVAL_MS } from '@/lib/inbox-expiry';
import { getArtifactsDir } from '@/lib/artifacts';
import type { ProjectManagerDeps, IMachineFactory, ISandboxFactory, IWorkflowLoader } from '@/lib/project-manager-deps';
import { classifyRunEndReason, decideRunEndAction } from '@/lib/run-end';
import { decideWorktreeAction } from '@/lib/worktree';
import type { FailureClass } from '@/lib/run-end';
import { hasTemplateExpressions, renderTemplate } from '@/lib/template';
import type { TemplateVariables } from '@/lib/template';
import { getMimeType, isTextMime } from '@/lib/mime-types';
import { buildSupervisorPrompt } from '@/main/supervisor-prompt';
import { TicketMachine } from '@/main/ticket-machine';
import type { ClientFunctionResponder } from '@/main/ticket-machine';
import { WorkflowLoader } from '@/main/workflow-loader';
import { AgentProcess } from '@/main/agent-process';
import type { ProcessManager } from '@/main/process-manager';
import { createPlatformClient } from '@/main/platform-mode';
import { getOmniConfigDir, getWorktreesDir } from '@/main/util';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { TicketPhase } from '@/shared/ticket-phase';
import { getLocalWorkspaceDir, requireLocalWorkspaceDir } from '@/shared/project-source';
import type {
  ArtifactFileContent,
  ArtifactFileEntry,
  CodeTabId,
  DiffResponse,
  FileDiff,
  ColumnId,
  InboxItem,
  InboxItemId,
  Initiative,
  InitiativeId,
  Pipeline,
  Project,
  ProjectId,
  SessionMessage,
  Task,
  TaskId,
  Ticket,
  TicketId,
  TicketPriority,
  AgentProcessStatus,
  WithTimestamp,
  GitRepoInfo,
  IpcEvents,
  IpcRendererEvents,
  StoreData,
} from '@/shared/types';

const execFileAsync = promisify(execFile);

const DEFAULT_BRIEF_TEMPLATE = `## Problem


## Appetite


## Solution direction


## Open questions
- [ ]

## Decisions


## Out of scope

`;

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
  const ticketBranch = `ticket/${name}`;

  await execFileAsync('git', ['-C', workspaceDir, 'worktree', 'add', '-b', ticketBranch, worktreePath, branch], {
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
    await execFileAsync('git', ['-C', workspaceDir, 'branch', '-D', `ticket/${worktreeName}`], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch (error) {
    console.warn(`Failed to delete branch ticket/${worktreeName}: ${error}`);
  }
};

// #endregion

// --- Symphony-inspired operational constants ---

/** Maximum number of supervisors that can run concurrently across all projects. */
const MAX_CONCURRENT_SUPERVISORS = 5;

/** If no supervisor message is received within this window, the run is considered stalled. */
const STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** How often to check for stalled supervisors. */
const STALL_CHECK_INTERVAL_MS = 30_000; // 30 seconds



/** Short delay before a continuation retry after a normal run end. */
const CONTINUATION_RETRY_DELAY_MS = 3_000;

/** Base delay for exponential backoff on failure-driven retries. */
const RETRY_BASE_DELAY_MS = 10_000;

/** Maximum backoff delay for failure retries. */
const MAX_RETRY_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum retry attempts before giving up. */
const MAX_RETRY_ATTEMPTS = 5;

/** Maximum continuation turns (successful run → re-check → continue). */
const MAX_CONTINUATION_TURNS = 10;

// classifyRunEndReason, decideRunEndAction, isWorkComplete imported from @/lib/run-end

export class ProjectManager {
  private tasks = new Map<TaskId, { task: Task; sandbox: AgentProcess }>();
  private machines = new Map<TicketId, { machine: TicketMachine; sandbox: AgentProcess | null }>();
  private ticketLocks = new Map<TicketId, Promise<void>>();
  private store: Store<StoreData>;
  private sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  /** Interval handle for periodic stall checks. */
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Workflow file loader (FLEET.md) per project. */
  private workflowLoader: IWorkflowLoader;

  /** Interval handle for auto-dispatch polling. */
  private autoDispatchTimer: ReturnType<typeof setInterval> | null = null;

  /** Interval handle for inbox expiry sweep. */
  private inboxSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Injectable factories for testing. */
  private sandboxFactory?: ISandboxFactory;
  private machineFactory?: IMachineFactory;

  /** Optional ProcessManager — when set, supervisor reuses Code tab sandboxes. */
  private processManager?: ProcessManager;

  constructor(
    arg: { store: Store<StoreData>; sendToWindow: ProjectManager['sendToWindow']; processManager?: ProcessManager },
    deps?: Partial<ProjectManagerDeps>
  ) {
    this.store = arg.store;
    this.sendToWindow = arg.sendToWindow;
    this.processManager = arg.processManager;
    // Let ProcessManager fall back to supervisor sandbox status for ticket-linked tabs
    if (this.processManager) {
      this.processManager.statusFallback = (processId) => this.getSupervisorStatusForCodeTab(processId);
    }
    this.workflowLoader = deps?.workflowLoader ?? new WorkflowLoader({
      onChange: (projectId, workflow) => {
        console.log(
          `[ProjectManager] FLEET.md reloaded for project ${projectId}` +
            (workflow.promptTemplate ? ' (has custom prompt)' : '') +
            (workflow.config.supervisor ? ' (has supervisor config)' : '') +
            (workflow.config.hooks ? ' (has hooks)' : '')
        );
        // Push updated pipeline to the renderer so the UI reflects FLEET.md changes
        const pipeline = this.getPipeline(projectId);
        this.sendToWindow('project:pipeline', projectId, pipeline);

        // Migrate tickets whose columnId no longer exists in the new pipeline
        this.migrateOrphanedTickets(projectId, pipeline);
      },
    });
    this.sandboxFactory = deps?.sandboxFactory;
    this.machineFactory = deps?.machineFactory;
    this.startStallDetection();
    this.startAutoDispatch();
    this.startInboxSweep();
  }

  // #region Machine factory

  private createMachine(ticketId: TicketId): TicketMachine {
    const callbacks = {
      onPhaseChange: (tid: TicketId, phase: TicketPhase) => {
        this.updateTicket(tid, { phase });
        this.sendToWindow('project:phase', tid, phase);
      },
      onMessage: (tid: TicketId, msg: SessionMessage) => {
        this.sendToWindow('project:supervisor-message', tid, msg);
      },
      onRunEnd: (tid: TicketId, reason: string) => {
        void this.handleMachineRunEnd(tid, reason);
      },
      onTokenUsage: (tid: TicketId, usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => {
        const ticket = this.getTicketById(tid);
        if (!ticket) return;
        const prev = ticket.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const updated = {
          inputTokens: Math.max(prev.inputTokens, usage.inputTokens),
          outputTokens: Math.max(prev.outputTokens, usage.outputTokens),
          totalTokens: Math.max(prev.totalTokens, usage.totalTokens),
        };
        if (updated.totalTokens !== prev.totalTokens) {
          this.updateTicket(tid, { tokenUsage: updated });
          this.sendToWindow('project:token-usage', tid, updated);
        }
      },
      onClientRequest: (tid: TicketId, functionName: string, args: Record<string, unknown>, respond: ClientFunctionResponder) => {
        // Auto-approve tool approval requests (project agents run unattended)
        if (functionName === 'ui.request_tool_approval') {
          respond(true, { approved: true, always_approve: true });
          return;
        }
        this.handleClientToolCall(tid, functionName, args, respond);
      },
    };

    if (this.machineFactory) {
      return this.machineFactory.create(ticketId, callbacks) as unknown as TicketMachine;
    }

    return new TicketMachine(ticketId, callbacks);
  }

  /**
   * Serialize async operations per ticket to prevent races between
   * start/stop/retry/stall-check for the same ticket.
   */
  private withTicketLock<T>(ticketId: TicketId, fn: () => Promise<T>): Promise<T> {
    const prev = this.ticketLocks.get(ticketId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.ticketLocks.set(
      ticketId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  /**
   * Handle a client tool call from the agent. The agent calls tools like
   * get_ticket / move_ticket / escalate via the existing WebSocket RPC
   * (client_request with function="tool.call") instead of a separate MCP server.
   */
  private handleClientToolCall(
    ticketId: TicketId,
    functionName: string,
    args: Record<string, unknown>,
    respond: (ok: boolean, result?: Record<string, unknown>) => void
  ): void {
    console.log(`[ProjectManager] handleClientToolCall: ticketId=${ticketId}, function=${functionName}, args=${JSON.stringify(args)}`);

    if (functionName !== 'tool.call') {
      // Not a tool call — ignore (other client_request functions handled elsewhere)
      return;
    }

    const toolName = args.tool as string | undefined;
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      respond(false, { error: { message: 'Missing tool name' } });
      return;
    }

    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      respond(true, { error: 'Ticket not found' });
      return;
    }

    const pipeline = this.getPipeline(ticket.projectId);

    switch (toolName) {
      case 'get_ticket': {
        const lookupId = (toolArgs.ticket_id as string) || ticketId;
        const target = this.getTicketById(lookupId);
        if (!target) {
          respond(true, { error: `Ticket not found: ${lookupId}` });
          return;
        }
        const targetPipeline = this.getPipeline(target.projectId);
        const column = targetPipeline.columns.find((c) => c.id === target.columnId);
        const comments = (target.comments ?? []).map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          created_at: new Date(c.createdAt).toISOString(),
        }));
        const runs = (target.runs ?? []).map((r) => ({
          id: r.id,
          started_at: new Date(r.startedAt).toISOString(),
          ended_at: new Date(r.endedAt).toISOString(),
          end_reason: r.endReason,
          token_usage: r.tokenUsage ?? null,
        }));
        respond(true, {
          id: target.id,
          title: target.title,
          description: target.description || '',
          priority: target.priority,
          column: column?.label ?? target.columnId,
          pipeline: targetPipeline.columns.map((c) => c.label),
          blocked_by: target.blockedBy ?? [],
          branch: target.branch || null,
          use_worktree: target.useWorktree ?? false,
          worktree_path: target.worktreePath || null,
          phase: target.phase ?? null,
          run_count: runs.length,
          created_at: new Date(target.createdAt).toISOString(),
          updated_at: new Date(target.updatedAt).toISOString(),
          comments,
          runs,
        });
        break;
      }
      case 'move_ticket': {
        const columnLabel = (toolArgs.column as string) ?? '';
        const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
        if (!col) {
          const valid = pipeline.columns.map((c) => c.label).join(', ');
          respond(true, { error: `Unknown column: "${columnLabel}". Valid columns: ${valid}` });
          return;
        }
        this.moveTicketToColumn(ticketId, col.id);
        respond(true, { ok: true, column: col.label });
        break;
      }
      case 'escalate': {
        const message = (toolArgs.message as string) ?? '';
        if (!message) {
          respond(true, { error: 'Empty escalation message' });
          return;
        }
        this.sendToWindow('toast:show', {
          level: 'warning',
          title: `Agent needs help: ${ticket.title}`,
          description: message,
        });
        const entry = this.machines.get(ticketId);
        if (entry?.machine.isStreaming()) {
          void entry.machine.stop().then(() => {
            entry.machine.forcePhase('awaiting_input');
            respond(true, { ok: true, message: 'Escalated to human operator' });
          });
        } else {
          respond(true, { ok: true, message: 'Escalated to human operator' });
        }
        break;
      }
      case 'notify': {
        const notifyMessage = (toolArgs.message as string) ?? '';
        if (!notifyMessage) {
          respond(true, { error: 'Empty notification message' });
          return;
        }
        this.sendToWindow('toast:show', {
          level: 'info',
          title: `Agent note: ${ticket.title}`,
          description: notifyMessage,
        });
        respond(true, { ok: true, message: 'Notification sent' });
        break;
      }
      case 'add_ticket_comment': {
        const commentTicketId = (toolArgs.ticket_id as string) || ticketId;
        const content = (toolArgs.content as string) ?? '';
        if (!content) {
          respond(true, { error: 'Missing content' });
          return;
        }
        const commentTarget = this.getTicketById(commentTicketId);
        if (!commentTarget) {
          respond(true, { error: `Ticket not found: ${commentTicketId}` });
          return;
        }
        const comment = { id: nanoid(), author: 'agent' as const, content, createdAt: Date.now() };
        const existingComments = commentTarget.comments ?? [];
        this.updateTicket(commentTicketId, { comments: [...existingComments, comment] });
        respond(true, { ok: true, comment_id: comment.id });
        break;
      }
      // --- Read-only context tools (available to all sessions including autopilot) ---
      case 'get_ticket_comments': {
        const commentsTicketId = (toolArgs.ticket_id as string) ?? '';
        if (!commentsTicketId) {
          respond(true, { error: 'Missing ticket_id' });
          return;
        }
        const commentsTarget = this.getTicketById(commentsTicketId);
        if (!commentsTarget) {
          respond(true, { error: `Ticket not found: ${commentsTicketId}` });
          return;
        }
        respond(true, {
          comments: (commentsTarget.comments ?? []).map((c) => ({
            id: c.id,
            author: c.author,
            content: c.content,
            created_at: new Date(c.createdAt).toISOString(),
          })),
        });
        break;
      }
      // --- Project-scoped tools (available in interactive sessions) ---
      case 'list_projects': {
        const projects = this.getProjects().map((p) => {
          const pl = this.getPipeline(p.id);
          return {
            id: p.id,
            label: p.label,
            workspaceDir: getLocalWorkspaceDir(p.source),
            columns: pl.columns.map((c) => c.label),
          };
        });
        respond(true, { projects });
        break;
      }
      case 'list_tickets': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(true, { error: 'Missing project_id' });
          return;
        }
        const pl = this.getPipeline(projectId);
        let tickets = this.getTicketsByProject(projectId);
        const columnFilter = toolArgs.column as string | undefined;
        if (columnFilter) {
          const col = pl.columns.find((c) => c.label.toLowerCase() === columnFilter.toLowerCase());
          if (col) tickets = tickets.filter((t) => t.columnId === col.id);
        }
        const priorityFilter = toolArgs.priority as string | undefined;
        if (priorityFilter) {
          tickets = tickets.filter((t) => t.priority === priorityFilter);
        }
        const result = tickets.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description || '',
          priority: t.priority,
          column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
          phase: t.phase,
          blocked_by: t.blockedBy ?? [],
          created_at: new Date(t.createdAt).toISOString(),
          updated_at: new Date(t.updatedAt).toISOString(),
        }));
        respond(true, { tickets: result });
        break;
      }
      case 'create_ticket': {
        const projectId = (toolArgs.project_id as string) ?? '';
        const title = (toolArgs.title as string) ?? '';
        if (!projectId || !title) {
          respond(true, { error: 'Missing project_id or title' });
          return;
        }
        const proj = this.getProjects().find((p) => p.id === projectId);
        if (!proj) {
          respond(true, { error: `Project not found: ${projectId}` });
          return;
        }
        const newTicket = this.addTicket({
          projectId,
          initiativeId: (toolArgs.initiative_id as string) || undefined,
          title,
          description: (toolArgs.description as string) ?? '',
          priority: (toolArgs.priority as TicketPriority) ?? 'medium',
          blockedBy: [],
        });
        respond(true, { id: newTicket.id, title: newTicket.title, column: this.getPipeline(projectId).columns[0]?.label });
        break;
      }
      case 'update_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(true, { error: 'Missing ticket_id' });
          return;
        }
        const target = this.getTicketById(targetId);
        if (!target) {
          respond(true, { error: `Ticket not found: ${targetId}` });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (toolArgs.title) patch.title = toolArgs.title;
        if (toolArgs.description !== undefined) patch.description = toolArgs.description;
        if (toolArgs.priority) patch.priority = toolArgs.priority;
        if (toolArgs.branch !== undefined) patch.branch = toolArgs.branch;
        // Dependency management
        if (toolArgs.add_blocked_by || toolArgs.remove_blocked_by) {
          const current = new Set(target.blockedBy ?? []);
          for (const id of (toolArgs.add_blocked_by as string[]) ?? []) current.add(id);
          for (const id of (toolArgs.remove_blocked_by as string[]) ?? []) current.delete(id);
          patch.blockedBy = [...current];
        }
        this.updateTicket(targetId, patch);
        respond(true, { ok: true });
        break;
      }
      case 'start_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(true, { error: 'Missing ticket_id' });
          return;
        }
        void this.startSupervisor(targetId).then(
          () => respond(true, { ok: true }),
          (err) => respond(true, { error: String(err) })
        );
        break;
      }
      case 'stop_ticket': {
        const targetId = (toolArgs.ticket_id as string) ?? '';
        if (!targetId) {
          respond(true, { error: 'Missing ticket_id' });
          return;
        }
        void this.stopSupervisor(targetId).then(
          () => respond(true, { ok: true }),
          (err) => respond(true, { error: String(err) })
        );
        break;
      }
      // --- Read-only context tools (available to all sessions including autopilot) ---
      case 'list_initiatives': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(true, { error: 'Missing project_id' });
          return;
        }
        const items = this.getInitiativesByProject(projectId);
        respond(true, {
          initiatives: items.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.description || '',
            branch: i.branch || null,
            status: i.status,
            is_default: i.isDefault ?? false,
            created_at: new Date(i.createdAt).toISOString(),
            updated_at: new Date(i.updatedAt).toISOString(),
          })),
        });
        break;
      }
      case 'read_brief': {
        const projectId = (toolArgs.project_id as string) ?? '';
        if (!projectId) {
          respond(true, { error: 'Missing project_id' });
          return;
        }
        const proj = this.getProjects().find((p) => p.id === projectId);
        if (!proj) {
          respond(true, { error: `Project not found: ${projectId}` });
          return;
        }
        respond(true, { brief: proj.brief ?? '' });
        break;
      }
      case 'read_initiative_brief': {
        const initId = (toolArgs.initiative_id as string) ?? '';
        if (!initId) {
          respond(true, { error: 'Missing initiative_id' });
          return;
        }
        const init = this.getInitiatives().find((i) => i.id === initId);
        if (!init) {
          respond(true, { error: `Initiative not found: ${initId}` });
          return;
        }
        respond(true, { brief: init.brief ?? '' });
        break;
      }
      case 'search_tickets': {
        const query = (toolArgs.query as string) ?? '';
        if (!query) {
          respond(true, { error: 'Missing query' });
          return;
        }
        const q = query.toLowerCase();
        const projectFilter = toolArgs.project_id as string | undefined;
        let allTickets = projectFilter
          ? this.getTicketsByProject(projectFilter)
          : this.getProjects().flatMap((p) => this.getTicketsByProject(p.id));
        const matches = allTickets.filter(
          (t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
        );
        const searchResult = matches.map((t) => {
          const pl = this.getPipeline(t.projectId);
          return {
            id: t.id,
            project_id: t.projectId,
            title: t.title,
            description: t.description || '',
            priority: t.priority,
            column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId,
            phase: t.phase,
            created_at: new Date(t.createdAt).toISOString(),
            updated_at: new Date(t.updatedAt).toISOString(),
          };
        });
        respond(true, { tickets: searchResult });
        break;
      }
      case 'get_ticket_history': {
        const historyTicketId = (toolArgs.ticket_id as string) ?? '';
        if (!historyTicketId) {
          respond(true, { error: 'Missing ticket_id' });
          return;
        }
        const historyTarget = this.getTicketById(historyTicketId);
        if (!historyTarget) {
          respond(true, { error: `Ticket not found: ${historyTicketId}` });
          return;
        }
        const historyRuns = (historyTarget.runs ?? []).map((r) => ({
          id: r.id,
          started_at: new Date(r.startedAt).toISOString(),
          ended_at: new Date(r.endedAt).toISOString(),
          end_reason: r.endReason,
          token_usage: r.tokenUsage ?? null,
        }));
        respond(true, {
          ticket_id: historyTarget.id,
          phase: historyTarget.phase ?? null,
          run_count: historyRuns.length,
          total_token_usage: historyTarget.tokenUsage ?? null,
          runs: historyRuns,
        });
        break;
      }
      case 'get_pipeline': {
        const pipelineProjectId = (toolArgs.project_id as string) ?? '';
        if (!pipelineProjectId) {
          respond(true, { error: 'Missing project_id' });
          return;
        }
        const pl = this.getPipeline(pipelineProjectId);
        respond(true, {
          columns: pl.columns.map((c) => ({
            id: c.id,
            label: c.label,
            description: c.description || null,
            gate: c.gate ?? false,
          })),
        });
        break;
      }
      default:
        respond(true, { error: `Unknown tool: ${toolName}` });
    }
  }

  /**
   * Handle a run_end notification from a machine. Decides whether to continue,
   * retry, or stop based on the run end reason and ticket state.
   */
  private handleMachineRunEnd = (ticketId: TicketId, reason: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      console.log(`[ProjectManager] Machine run ended for ${ticketId}: ${reason}`);

      const entry = this.machines.get(ticketId);
      if (!entry) return;
      const { machine } = entry;

      // Guard: ignore if machine was already stopped/transitioned (e.g., user clicked Stop)
      if (!machine.isStreaming()) {
        console.log(
          `[ProjectManager] Ignoring run_end for ${ticketId} — machine in phase ${machine.getPhase()}`
        );
        return;
      }

      // Run after_run hook (best-effort)
      const ticket = this.getTicketById(ticketId);
      if (ticket) {
        const project = this.getProjects().find((p) => p.id === ticket.projectId);
        if (project?.source.kind === 'local') {
          void this.workflowLoader.runHook(ticket.projectId, 'after_run', project.source.workspaceDir);
        } else if (project?.source.kind === 'git-remote') {
          const hookScript = this.workflowLoader.getConfig(ticket.projectId).hooks?.after_run;
          if (hookScript) {
            const entry = this.machines.get(ticketId);
            if (entry?.sandbox) {
              void entry.sandbox.execInContainer(hookScript, '/home/user/workspace');
            }
          }
        }
      }

      const maxTurns = ticket
        ? this.getEffectiveMaxContinuationTurns(ticket.projectId)
        : MAX_CONTINUATION_TURNS;

      const action = decideRunEndAction({
        reason,
        continuationTurn: machine.continuationTurn,
        maxContinuationTurns: maxTurns,
      });

      // Persist run record
      if (ticket) {
        const run = {
          id: nanoid(),
          startedAt: ticket.updatedAt, // best approximation — updated when run starts
          endedAt: Date.now(),
          endReason: reason,
          tokenUsage: ticket.tokenUsage ? { ...ticket.tokenUsage } : undefined,
        };
        const existingRuns = ticket.runs ?? [];
        this.updateTicket(ticketId, { runs: [...existingRuns, run] });
      }

      switch (action.type) {
        case 'stopped':
          machine.transition('idle');
          return;

        case 'complete':
          console.log(`[ProjectManager] Ticket ${ticketId} work complete.`);
          machine.transition('completed');
          return;

        case 'continue': {
          // Re-read ticket — the agent may have moved it during the run
          const freshTicket = this.getTicketById(ticketId);
          if (freshTicket) {
            if (this.isTerminalColumn(freshTicket.projectId, freshTicket.columnId)) {
              console.log(`[ProjectManager] Ticket ${ticketId} is in terminal column — not continuing.`);
              machine.transition('completed');
              return;
            }
            const col = this.getColumn(freshTicket.projectId, freshTicket.columnId);
            if (col?.gate) {
              console.log(`[ProjectManager] Ticket ${ticketId} is in gated column "${freshTicket.columnId}" — not continuing.`);
              machine.transition('idle');
              return;
            }
          }

          machine.continuationTurn = action.nextTurn;
          machine.transition('continuing');
          machine.recordActivity();

          console.log(
            `[ProjectManager] Continuing ticket ${ticketId} (turn ${action.nextTurn}/${maxTurns}).`
          );

          const sessionId = machine.getSessionId() ?? undefined;
          const continuationPrompt = this.buildContinuationPrompt(ticketId, action.nextTurn + 1, maxTurns);
          // Brief delay to let the server's worker task finish cleanup (clear current_task)
          // before we send the next start_run, avoiding "Run already active" race.
          await new Promise((r) => setTimeout(r, 500));
          this.startMachineRun(ticketId, continuationPrompt, { sessionId });
          return;
        }

        case 'retry':
          this.scheduleRetry(ticketId, action.failureClass, {
            attempt: machine.retryAttempt + 1,
            continuationTurn: machine.continuationTurn,
            error: reason,
          });
          return;
      }
    });
  };

  // #endregion

  // #region Effective config (FLEET.md overrides → defaults)

  /**
   * Get the effective stall timeout for a project, respecting FLEET.md overrides.
   */
  private getEffectiveStallTimeout = (projectId: ProjectId): number => {
    return this.workflowLoader.getConfig(projectId).supervisor?.stall_timeout_ms ?? STALL_TIMEOUT_MS;
  };

  /**
   * Get the effective max concurrent supervisors, respecting FLEET.md overrides.
   * Uses the minimum of global limit and per-project limit (if set).
   */
  private getEffectiveMaxConcurrent = (projectId?: ProjectId): number => {
    if (!projectId) {
      return MAX_CONCURRENT_SUPERVISORS;
    }
    const projectLimit = this.workflowLoader.getConfig(projectId).supervisor?.max_concurrent;
    if (projectLimit !== undefined) {
      return Math.min(projectLimit, MAX_CONCURRENT_SUPERVISORS);
    }
    return MAX_CONCURRENT_SUPERVISORS;
  };

  private getEffectiveMaxRetries = (projectId: ProjectId): number => {
    return this.workflowLoader.getConfig(projectId).supervisor?.max_retry_attempts ?? MAX_RETRY_ATTEMPTS;
  };

  private getEffectiveMaxContinuationTurns = (projectId: ProjectId): number => {
    return this.workflowLoader.getConfig(projectId).supervisor?.max_continuation_turns ?? MAX_CONTINUATION_TURNS;
  };

  /** Check if auto-dispatch is enabled for a project (FLEET.md or project setting). */
  private isAutoDispatchEnabled = (projectId: ProjectId): boolean => {
    const project = this.getProjects().find((p) => p.id === projectId);
    if (project?.autoDispatch) {
      return true;
    }
    return this.workflowLoader.getConfig(projectId).supervisor?.auto_dispatch ?? false;
  };

  /** Get per-column concurrency limit from FLEET.md config. */
  private getColumnMaxConcurrent = (projectId: ProjectId, columnId: ColumnId): number | undefined => {
    return this.workflowLoader.getConfig(projectId).supervisor?.max_concurrent_by_column?.[columnId];
  };

  // #endregion

  // #region Stall detection (Symphony-inspired)

  private startStallDetection = (): void => {
    this.stallCheckTimer = setInterval(() => this.checkForStalledSupervisors(), STALL_CHECK_INTERVAL_MS);
  };

  private checkForStalledSupervisors = (): void => {
    const now = Date.now();

    for (const [ticketId, entry] of this.machines) {
      const { machine } = entry;
      const phase = machine.getPhase();

      // Only check for stalls in non-terminal phases that aren't actively running.
      // An active run (running/continuing) is never stalled — the agent may be
      // executing long tool calls. We only detect stalls in phases where the
      // machine is stuck without progressing (e.g. provisioning, connecting).
      if (!machine.isActive() || machine.isStreaming()) continue;
      // Skip phases that have their own timeouts or are waiting intentionally.
      // 'ready' means the session exists but no autonomous run was started — the user
      // may be using the workspace manually, so don't treat it as stalled.
      if (phase === 'retrying' || phase === 'awaiting_input' || phase === 'ready') continue;

      const ticket = this.getTicketById(ticketId);
      const stallTimeout = ticket ? this.getEffectiveStallTimeout(ticket.projectId) : STALL_TIMEOUT_MS;

      const elapsed = now - machine.getLastActivity();
      if (elapsed > stallTimeout) {
        void this.withTicketLock(ticketId, async () => {
          // Re-check under lock
          if (!machine.isActive() || machine.isStreaming()) return;
          if (machine.getPhase() === 'retrying' || machine.getPhase() === 'awaiting_input') return;
          const elapsedNow = Date.now() - machine.getLastActivity();
          if (elapsedNow <= stallTimeout) return;

          console.warn(
            `[ProjectManager] Supervisor stalled for ticket ${ticketId} in phase "${machine.getPhase()}" (${Math.round(elapsedNow / 1000)}s since last activity). Stopping and scheduling retry.`
          );
          await machine.stop();

          this.scheduleRetry(ticketId, 'stalled', {
            attempt: machine.retryAttempt + 1,
            continuationTurn: machine.continuationTurn,
            error: `stalled in phase ${machine.getPhase()} for ${Math.round(elapsedNow / 1000)}s`,
          });
        });
      }
    }
  };

  // #endregion

  // #region Concurrency control (Symphony-inspired)

  /** Returns the number of supervisors currently active. */
  private getRunningSupervisorCount = (): number => {
    let count = 0;
    for (const [, entry] of this.machines) {
      if (entry.machine.isActive()) count++;
    }
    return count;
  };

  /** Count active supervisors in a specific column for a project. */
  private getRunningSupervisorCountByColumn = (projectId: ProjectId, columnId: ColumnId): number => {
    let count = 0;
    for (const [ticketId, entry] of this.machines) {
      if (!entry.machine.isActive()) continue;
      const ticket = this.getTicketById(ticketId);
      if (ticket && ticket.projectId === projectId && ticket.columnId === columnId) {
        count++;
      }
    }
    return count;
  };

  /**
   * Get all tickets with active supervisor phases across all projects.
   * Used for WIP limit enforcement and the "Right Now" view.
   */
  getActiveWipTickets = (): Ticket[] => {
    return this.getTickets().filter((t) => t.phase && isActivePhase(t.phase));
  };

  /** Check if a new supervisor can be started within global and per-column concurrency limits. */
  private canStartSupervisor = (projectId?: ProjectId, columnId?: ColumnId): boolean => {
    if (this.getRunningSupervisorCount() >= MAX_CONCURRENT_SUPERVISORS) {
      return false;
    }
    // Check per-column limit if applicable
    if (projectId && columnId) {
      const columnLimit = this.getColumnMaxConcurrent(projectId, columnId);
      if (columnLimit !== undefined) {
        return this.getRunningSupervisorCountByColumn(projectId, columnId) < columnLimit;
      }
    }
    return true;
  };

  // #endregion

  // #region Retry queue (Symphony-inspired)

  /**
   * Schedule a retry for a ticket's supervisor.
   * Continuation retries (after normal completion) use a short fixed delay.
   * Failure retries use exponential backoff.
   */
  private scheduleRetry = (
    ticketId: TicketId,
    failureClass: FailureClass,
    opts: { attempt?: number; continuationTurn?: number; error?: string }
  ): void => {
    const entry = this.machines.get(ticketId);
    if (!entry) return;
    const { machine } = entry;

    const attempt = opts.attempt ?? 0;
    const continuationTurn = opts.continuationTurn ?? 0;

    // Update machine counters
    machine.retryAttempt = attempt;
    machine.continuationTurn = continuationTurn;

    // Get per-project limits from FLEET.md
    const ticket = this.getTicketById(ticketId);
    const maxContinuationTurns = ticket
      ? this.getEffectiveMaxContinuationTurns(ticket.projectId)
      : MAX_CONTINUATION_TURNS;
    const maxRetryAttempts = ticket ? this.getEffectiveMaxRetries(ticket.projectId) : MAX_RETRY_ATTEMPTS;

    // Check limits
    if (failureClass === 'completed' && continuationTurn >= maxContinuationTurns) {
      console.log(
        `[ProjectManager] Ticket ${ticketId} reached max continuation turns (${maxContinuationTurns}). Stopping.`
      );
      machine.transition('idle');
      return;
    }

    if (failureClass !== 'completed' && attempt >= maxRetryAttempts) {
      console.log(`[ProjectManager] Ticket ${ticketId} reached max retry attempts (${maxRetryAttempts}). Giving up.`);
      machine.transition('error');
      return;
    }

    // Calculate delay
    let delayMs: number;
    if (failureClass === 'completed') {
      delayMs = CONTINUATION_RETRY_DELAY_MS;
    } else {
      delayMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_BACKOFF_MS);
    }

    console.log(
      `[ProjectManager] Scheduling ${failureClass === 'completed' ? 'continuation' : 'retry'} for ${ticketId} ` +
        `(attempt=${attempt}, turn=${continuationTurn}) in ${Math.round(delayMs / 1000)}s` +
        (opts.error ? ` (reason: ${opts.error})` : '')
    );

    machine.scheduleRetryTimer(delayMs, () => {
      void this.handleRetryFired(ticketId, failureClass, attempt, continuationTurn);
    });
  };

  /**
   * Handle a retry timer firing. Re-check ticket state and re-dispatch if still eligible.
   */
  private handleRetryFired = (
    ticketId: TicketId,
    failureClass: FailureClass,
    attempt: number,
    continuationTurn: number
  ): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const ticket = this.getTicketById(ticketId);
      const entry = this.machines.get(ticketId);
      if (!ticket || !entry) {
        console.log(`[ProjectManager] Retry fired for ${ticketId} but ticket/machine no longer exists. Releasing.`);
        return;
      }
      const { machine } = entry;

      // Don't retry if ticket is now in a terminal column
      if (this.isTerminalColumn(ticket.projectId, ticket.columnId)) {
        console.log(`[ProjectManager] Retry fired for ${ticketId} but ticket is in terminal column. Releasing.`);
        machine.transition('idle');
        return;
      }

      // Check concurrency (including per-column limits)
      if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
        console.log(`[ProjectManager] No slots available for retry of ${ticketId}. Requeuing.`);
        this.scheduleRetry(ticketId, failureClass, {
          attempt: attempt + 1,
          continuationTurn,
          error: 'no available supervisor slots',
        });
        return;
      }

      // Re-dispatch
      console.log(
        `[ProjectManager] Retry firing for ${ticketId} (${failureClass}, attempt=${attempt}, turn=${continuationTurn}). Re-dispatching.`
      );

      try {
        const project = this.getProjects().find((p) => p.id === ticket.projectId);
        if (!project) return;

        let hookOk = true;
        if (project.source.kind === 'local') {
          hookOk = await this.workflowLoader.runHook(ticket.projectId, 'before_run', project.source.workspaceDir);
        } else {
          const hookScript = this.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
          if (hookScript) {
            const entry = this.machines.get(ticketId);
            if (entry?.sandbox) {
              hookOk = await entry.sandbox.execInContainer(hookScript, '/home/user/workspace');
            }
          }
        }
        if (!hookOk) {
          console.warn(
            `[ProjectManager] before_run hook failed during retry for ${ticketId}. Scheduling another retry.`
          );
          this.scheduleRetry(ticketId, 'error', {
            attempt: attempt + 1,
            continuationTurn,
            error: 'before_run hook failed',
          });
          return;
        }

        const sessionId = ticket.supervisorSessionId ?? undefined;
        const isContinuation = failureClass === 'completed';
        const maxTurns = this.getEffectiveMaxContinuationTurns(ticket.projectId);
        const prompt = isContinuation
          ? this.buildContinuationPrompt(ticketId, continuationTurn + 1, maxTurns)
          : 'The previous run failed. Please review the current state and continue working on this ticket.';
        const variables = isContinuation
          ? undefined
          : this.buildRunVariables(ticketId);

        machine.recordActivity();
        await this.ensureSupervisorInfra(ticketId);
        this.startMachineRun(ticketId, prompt, { sessionId, variables });
      } catch (error) {
        console.error(`[ProjectManager] Retry dispatch failed for ${ticketId}:`, error);
        this.scheduleRetry(ticketId, 'error', {
          attempt: attempt + 1,
          continuationTurn,
          error: (error as Error).message,
        });
      }
    });
  };

  private cancelRetry = (ticketId: TicketId): void => {
    const entry = this.machines.get(ticketId);
    if (entry) {
      entry.machine.cancelRetryTimer();
    }
  };

  private cancelAllRetries = (): void => {
    for (const [, entry] of this.machines) {
      entry.machine.cancelRetryTimer();
    }
  };

  // #endregion

  // #endregion

  // #region Projects (persisted in electron-store)

  private getProjects = (): Project[] => {
    return this.store.get('projects', []);
  };

  private setProjects = (projects: Project[]): void => {
    this.store.set('projects', projects);
    this.sendToWindow('store:changed', this.store.store);
  };

  addProject = (input: Omit<Project, 'id' | 'createdAt'>): Project => {
    const project: Project = {
      ...input,
      id: nanoid(),
      createdAt: Date.now(),
      brief: input.brief ?? DEFAULT_BRIEF_TEMPLATE,
    };
    const projects = this.getProjects();
    projects.push(project);
    this.setProjects(projects);
    // Create the default "General" initiative for the new project
    this.createDefaultInitiative(project.id);
    // Eagerly load FLEET.md so pipeline is ready when the UI fetches it
    if (project.source.kind === 'local') {
      void this.workflowLoader.load(project.id, project.source.workspaceDir);
    } else {
      void this.workflowLoader.loadFromRemote(project.id, project.source.repoUrl, project.source.defaultBranch);
    }
    return project;
  };

  updateProject = (id: ProjectId, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): void => {
    const projects = this.getProjects();
    const index = projects.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    projects[index] = { ...projects[index]!, ...patch };
    this.setProjects(projects);
  };

  removeProject = async (id: ProjectId): Promise<void> => {
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
    const remainingInitiatives = this.getInitiatives().filter((i) => i.projectId !== id);
    this.setInitiatives(remainingInitiatives);
  };

  // #endregion

  // #region Pipeline helpers

  /** Load FLEET.md for a project if not already loaded. */
  ensureWorkflowLoaded = async (projectId: ProjectId): Promise<void> => {
    if (this.workflowLoader.get(projectId)) {
      return;
    }
    const project = this.getProjects().find((p) => p.id === projectId);
    if (!project) return;

    if (project.source.kind === 'local') {
      await this.workflowLoader.load(projectId, project.source.workspaceDir);
    } else {
      await this.workflowLoader.loadFromRemote(projectId, project.source.repoUrl, project.source.defaultBranch);
    }
    // Migrate any tickets with stale columnIds after first load
    const pipeline = this.getPipeline(projectId);
    this.migrateOrphanedTickets(projectId, pipeline);
  };

  getPipeline = (projectId: ProjectId): Pipeline => {
    // Priority: FLEET.md pipeline → project.pipeline → DEFAULT_PIPELINE
    const workflowPipeline = this.workflowLoader.getConfig(projectId).pipeline;
    if (workflowPipeline && workflowPipeline.columns.length > 0) {
      return {
        columns: workflowPipeline.columns.map((col) => ({
          id: col.id,
          label: col.label,
        })),
      };
    }
    const project = this.getProjects().find((p) => p.id === projectId);
    return project?.pipeline ?? DEFAULT_PIPELINE;
  };

  private getColumn = (projectId: ProjectId, columnId: ColumnId) => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns.find((c) => c.id === columnId);
  };

  /** The first column in the pipeline (where new tickets land). */
  private getFirstColumnId = (projectId: ProjectId): ColumnId => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns[0]?.id ?? 'backlog';
  };

  /** The last column in the pipeline (terminal — stops supervisor). */
  private getTerminalColumnId = (projectId: ProjectId): ColumnId => {
    const pipeline = this.getPipeline(projectId);
    return pipeline.columns[pipeline.columns.length - 1]?.id ?? 'completed';
  };

  /** Check if a column is the terminal (last) column for a project. */
  private isTerminalColumn = (projectId: ProjectId, columnId: ColumnId): boolean => {
    return columnId === this.getTerminalColumnId(projectId);
  };

  /** Check if a column is the first (backlog) column for a project. */
  private isFirstColumn = (projectId: ProjectId, columnId: ColumnId): boolean => {
    return columnId === this.getFirstColumnId(projectId);
  };

  /** Move tickets whose columnId no longer exists in the pipeline to the first column. */
  private migrateOrphanedTickets = (projectId: ProjectId, pipeline: Pipeline): void => {
    const columnIds = new Set(pipeline.columns.map((c) => c.id));
    const firstColumnId = pipeline.columns[0]?.id;
    if (!firstColumnId) return;

    const tickets = this.getTickets();
    let changed = false;
    for (const ticket of tickets) {
      if (ticket.projectId === projectId && ticket.columnId && !columnIds.has(ticket.columnId)) {
        console.log(`[ProjectManager] Migrating ticket ${ticket.id} from orphaned column "${ticket.columnId}" to "${firstColumnId}"`);
        ticket.columnId = firstColumnId;
        changed = true;
      }
    }
    if (changed) {
      this.setTickets(tickets);
    }
  };

  // #endregion

  // #region Tickets (persisted in electron-store)

  private getTickets = (): Ticket[] => {
    return this.store.get('tickets', []);
  };

  private setTickets = (tickets: Ticket[]): void => {
    this.store.set('tickets', tickets);
    this.sendToWindow('store:changed', this.store.store);
  };

  private getTicketById = (ticketId: TicketId): Ticket | undefined => {
    return this.getTickets().find((t) => t.id === ticketId);
  };

  addTicket = (
    input: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'columnId' | 'initiativeId'> & { initiativeId?: InitiativeId }
  ): Ticket => {
    const now = Date.now();
    const initiativeId = input.initiativeId ?? this.getDefaultInitiativeId(input.projectId);
    const ticket: Ticket = {
      ...input,
      initiativeId,
      id: nanoid(),
      columnId: this.getFirstColumnId(input.projectId),
      createdAt: now,
      updatedAt: now,
    };
    const tickets = this.getTickets();
    tickets.push(ticket);
    this.setTickets(tickets);
    return ticket;
  };

  updateTicket = (id: TicketId, patch: Partial<Omit<Ticket, 'id' | 'projectId' | 'createdAt'>>): void => {
    const tickets = this.getTickets();
    const index = tickets.findIndex((t) => t.id === id);
    if (index === -1) {
      return;
    }
    tickets[index] = { ...tickets[index]!, ...patch, updatedAt: Date.now() };
    this.setTickets(tickets);
  };

  removeTicket = (id: TicketId): void => {
    // Stop machine if running
    const machineEntry = this.machines.get(id);
    if (machineEntry) {
      void machineEntry.machine.dispose();
      void machineEntry.sandbox?.exit();
      this.machines.delete(id);
    }

    const tickets = this.getTickets().filter((t) => t.id !== id);
    this.setTickets(tickets);
  };

  getTicketsByProject = (projectId: ProjectId): Ticket[] => {
    return this.getTickets().filter((t) => t.projectId === projectId);
  };

  getTasks = (): Task[] => {
    return Array.from(this.tasks.values()).map((entry) => entry.task);
  };

  private static PRIORITY_ORDER: Record<TicketPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  getNextTicket = (projectId: ProjectId): Ticket | null => {
    const tickets = this.getTicketsByProject(projectId);
    const ticketMap = new Map(tickets.map((t) => [t.id, t]));

    const isBlocked = (ticket: Ticket): boolean => {
      return ticket.blockedBy.some((blockerId) => {
        const blocker = ticketMap.get(blockerId);
        // A ticket is blocked if the blocker is not in the terminal column
        return blocker && !this.isTerminalColumn(projectId, blocker.columnId);
      });
    };

    const firstColumnId = this.getFirstColumnId(projectId);
    const candidates = tickets.filter((t) => t.columnId === firstColumnId && !isBlocked(t));
    candidates.sort((a, b) => {
      const priorityDiff = ProjectManager.PRIORITY_ORDER[a.priority] - ProjectManager.PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.createdAt - b.createdAt;
    });

    return candidates[0] ?? null;
  };

  // #endregion

  // #region Inbox (persisted in electron-store)

  private getInboxItems = (): InboxItem[] => {
    return this.store.get('inboxItems') ?? [];
  };

  private setInboxItems = (items: InboxItem[]): void => {
    this.store.set('inboxItems', items);
    this.sendToWindow('store:changed', this.store.store);
  };

  addInboxItem = (input: Omit<InboxItem, 'id' | 'createdAt' | 'updatedAt'>): InboxItem => {
    const now = Date.now();
    const item: InboxItem = { ...input, id: nanoid(), createdAt: now, updatedAt: now };
    const items = this.getInboxItems();
    items.push(item);
    this.setInboxItems(items);
    return item;
  };

  updateInboxItem = (id: InboxItemId, patch: Partial<Omit<InboxItem, 'id' | 'createdAt'>>): void => {
    const items = this.getInboxItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return;
    items[index] = { ...items[index]!, ...patch, updatedAt: Date.now() };
    this.setInboxItems(items);
  };

  removeInboxItem = (id: InboxItemId): void => {
    const items = this.getInboxItems().filter((i) => i.id !== id);
    this.setInboxItems(items);
  };

  getInboxItemList = (): InboxItem[] => {
    return this.getInboxItems();
  };

  getIceboxItems = (): InboxItem[] => {
    return this.getInboxItems().filter((i) => i.status === 'iceboxed');
  };

  restoreFromIcebox = (id: InboxItemId): void => {
    const items = this.getInboxItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return;
    const now = Date.now();
    items[index] = { ...items[index]!, status: 'open', createdAt: now, updatedAt: now };
    this.setInboxItems(items);
  };

  /**
   * Sweep expired inbox items — moves open items older than 7 days to iceboxed.
   * Called on startup and on an hourly interval.
   */
  sweepExpiredInboxItems = (): void => {
    const items = this.getInboxItems();
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (isExpired(items[i]!, now)) {
        items[i] = { ...items[i]!, status: 'iceboxed', updatedAt: now };
        changed = true;
      }
    }
    if (changed) {
      this.setInboxItems(items);
      console.log('[ProjectManager] Swept expired inbox items to icebox');
    }
  };

  private startInboxSweep = (): void => {
    this.sweepExpiredInboxItems();
    this.inboxSweepTimer = setInterval(() => this.sweepExpiredInboxItems(), INBOX_SWEEP_INTERVAL_MS);
  };

  shapeInboxItem = (id: InboxItemId, shaping: import('@/shared/types').ShapingData): void => {
    const items = this.getInboxItems();
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return;
    items[index] = { ...items[index]!, shaping, updatedAt: Date.now() };
    this.setInboxItems(items);
  };

  /**
   * Convert a shaped inbox item to a ticket. Requires shaping data to be present.
   * Marks the inbox item as done and links the new ticket.
   */
  convertInboxToTicket = (id: InboxItemId, projectId: ProjectId): Ticket => {
    const items = this.getInboxItems();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Inbox item ${id} not found`);
    if (!item.shaping) throw new Error('Cannot convert unshaped inbox item to ticket');

    const ticket = this.addTicket({
      title: item.title,
      description: item.description ?? '',
      priority: 'medium',
      blockedBy: [],
      projectId,
      shaping: item.shaping,
    });

    this.updateInboxItem(id, {
      status: 'done',
      projectId,
      linkedTicketIds: [...(item.linkedTicketIds ?? []), ticket.id],
    });

    return ticket;
  };

  // #endregion

  // #region Initiatives (persisted in electron-store)

  private getInitiatives = (): Initiative[] => {
    return this.store.get('initiatives') ?? [];
  };

  private setInitiatives = (items: Initiative[]): void => {
    this.store.set('initiatives', items);
    this.sendToWindow('store:changed', this.store.store);
  };

  /** Get the default initiative ID for a project. Creates one if missing (defensive). */
  getDefaultInitiativeId = (projectId: ProjectId): InitiativeId => {
    const initiatives = this.getInitiatives();
    const defaultInit = initiatives.find((i) => i.projectId === projectId && i.isDefault);
    if (defaultInit) return defaultInit.id;
    // Defensive: create one if somehow missing
    const created = this.createDefaultInitiative(projectId);
    return created.id;
  };

  /** Create the "General" default initiative for a project. */
  private createDefaultInitiative = (projectId: ProjectId): Initiative => {
    const now = Date.now();
    const initiative: Initiative = {
      id: nanoid(),
      projectId,
      title: 'General',
      description: 'Default initiative',
      status: 'active',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };
    const initiatives = this.getInitiatives();
    initiatives.push(initiative);
    this.setInitiatives(initiatives);
    return initiative;
  };

  getInitiativesByProject = (projectId: ProjectId): Initiative[] => {
    return this.getInitiatives().filter((i) => i.projectId === projectId);
  };

  addInitiative = (input: Omit<Initiative, 'id' | 'createdAt' | 'updatedAt'>): Initiative => {
    const now = Date.now();
    const initiative: Initiative = { ...input, id: nanoid(), createdAt: now, updatedAt: now };
    const initiatives = this.getInitiatives();
    initiatives.push(initiative);
    this.setInitiatives(initiatives);
    return initiative;
  };

  updateInitiative = (id: InitiativeId, patch: Partial<Omit<Initiative, 'id' | 'projectId' | 'createdAt'>>): void => {
    const initiatives = this.getInitiatives();
    const index = initiatives.findIndex((i) => i.id === id);
    if (index === -1) return;
    initiatives[index] = { ...initiatives[index]!, ...patch, updatedAt: Date.now() };
    this.setInitiatives(initiatives);
  };

  removeInitiative = (id: InitiativeId): void => {
    const initiatives = this.getInitiatives();
    const target = initiatives.find((i) => i.id === id);
    if (!target || target.isDefault) return; // Cannot delete default initiative
    // Reassign orphaned tickets to the default initiative
    const defaultId = this.getDefaultInitiativeId(target.projectId);
    const tickets = this.getTickets();
    let ticketsChanged = false;
    for (const ticket of tickets) {
      if (ticket.initiativeId === id) {
        ticket.initiativeId = defaultId;
        ticket.updatedAt = Date.now();
        ticketsChanged = true;
      }
    }
    if (ticketsChanged) this.setTickets(tickets);
    this.setInitiatives(initiatives.filter((i) => i.id !== id));
  };

  /** Resolve the effective branch for a ticket (ticket.branch ?? initiative.branch ?? undefined). */
  resolveTicketBranch = (ticket: Ticket): string | undefined => {
    if (ticket.branch) return ticket.branch;
    const initiative = this.getInitiatives().find((i) => i.id === ticket.initiativeId);
    return initiative?.branch;
  };

  // #endregion

  // #region Artifacts

  private getArtifactsRoot = (ticketId: TicketId): string => {
    const configDir = getOmniConfigDir();
    return getArtifactsDir(configDir, ticketId);
  };

  private validateArtifactPath = (ticketId: TicketId, relativePath: string): string => {
    const root = this.getArtifactsRoot(ticketId);
    const fullPath = path.resolve(root, relativePath);
    if (!fullPath.startsWith(root)) {
      throw new Error('Path traversal detected');
    }
    return fullPath;
  };

  listArtifacts = async (ticketId: TicketId, dirPath?: string): Promise<ArtifactFileEntry[]> => {
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

  readArtifact = async (ticketId: TicketId, relativePath: string): Promise<ArtifactFileContent> => {
    const fullPath = this.validateArtifactPath(ticketId, relativePath);
    const stat = await fs.stat(fullPath);
    const mimeType = getMimeType(relativePath);

    if (isTextMime(mimeType) && stat.size <= 512_000) {
      const textContent = await fs.readFile(fullPath, 'utf-8');
      return { relativePath, mimeType, textContent, size: stat.size };
    }

    return { relativePath, mimeType, textContent: null, size: stat.size };
  };

  openArtifactExternal = async (ticketId: TicketId, relativePath: string): Promise<void> => {
    const fullPath = this.validateArtifactPath(ticketId, relativePath);
    await shell.openPath(fullPath);
  };

  // #endregion

  // #region Files changed (git diff)

  getFilesChanged = async (ticketId: TicketId): Promise<DiffResponse> => {
    const empty: DiffResponse = { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, hasChanges: false, files: [] };

    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return empty;
    }

    // Find the task associated with this ticket (via supervisorTaskId or ticketId on task)
    let task: Task | undefined;
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
      const storedTasks = this.store.get('tasks') ?? [];
      task = storedTasks.find((t) => t.ticketId === ticketId);
    }

    // Determine the git directory and merge base reference.
    // Case 1: task has a worktree → diff worktree against its base branch
    // Case 2: no worktree (supervisor mode) → diff project workspaceDir against upstream tracking branch
    let gitDir: string;
    let mergeBase: string;

    const worktreePath = ticket.worktreePath ?? task?.worktreePath;
    const worktreeBranch = this.resolveTicketBranch(ticket) ?? task?.branch;

    if (worktreePath && worktreeBranch) {
      gitDir = worktreePath;
      try {
        await fs.access(gitDir);
      } catch {
        return empty;
      }
      try {
        const { stdout } = await execFileAsync('git', ['-C', gitDir, 'merge-base', worktreeBranch, 'HEAD'], {
          timeout: 10_000,
        });
        mergeBase = stdout.trim();
      } catch {
        mergeBase = worktreeBranch;
      }
    } else {
      // Supervisor mode: no worktree, diff the project workspace against its upstream
      const project = this.getProjects().find((p) => p.id === ticket.projectId);
      if (!project || project.source.kind !== 'local') {
        return empty; // git-remote diffs happen inside the container, not locally
      }
      gitDir = project.source.workspaceDir;
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

  resolveTicket = (ticketId: TicketId, resolution: import('@/shared/types').TicketResolution): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return;
    this.updateTicket(ticketId, { resolution });
    const terminalColumnId = this.getTerminalColumnId(ticket.projectId);
    if (ticket.columnId !== terminalColumnId) {
      this.moveTicketToColumn(ticketId, terminalColumnId);
    }
  };

  moveTicketToColumn = (ticketId: TicketId, columnId: ColumnId): void => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const column = this.getColumn(ticket.projectId, columnId);
    if (!column) {
      return;
    }

    this.updateTicket(ticketId, { columnId });

    // Clear resolution when moving away from terminal column (reopen)
    const ticket2 = this.getTicketById(ticketId);
    if (ticket2?.resolution && !this.isTerminalColumn(ticket.projectId, columnId)) {
      this.updateTicket(ticketId, { resolution: undefined });
    }

    // Reconciliation: stop supervisor and clean up workspace when ticket moves to a terminal column
    if (this.isTerminalColumn(ticket.projectId, columnId)) {
      // Cancel any pending retry timer first to prevent re-dispatch races
      this.cancelRetry(ticketId);
      const entry = this.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} moved to terminal column "${columnId}" — stopping supervisor and cleaning up workspace.`);
        void this.withTicketLock(ticketId, async () => {
          await entry.machine.stop();
          await this.cleanupTicketWorkspace(ticketId);
        });
      } else {
        void this.cleanupTicketWorkspace(ticketId);
      }
    }

    // Also stop if moving back to the first column (user is shelving the ticket)
    if (this.isFirstColumn(ticket.projectId, columnId)) {
      const entry = this.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} moved to backlog — stopping supervisor.`);
        void this.stopSupervisor(ticketId);
      }
    }

    // Stop supervisor (preserve workspace) when entering a gated column
    if (column.gate) {
      const entry = this.machines.get(ticketId);
      if (entry) {
        console.log(`[ProjectManager] Ticket ${ticketId} entered gated column "${columnId}" — stopping supervisor.`);
        void this.stopSupervisor(ticketId);
      }
    }
  };

  // #endregion

  // #endregion

  // #region Supervisor lifecycle

  /**
   * Ensure sandbox + machine infrastructure exists for a ticket.
   * Idempotent — if a machine is already provisioned with a running sandbox, returns immediately.
   * Returns only after the sandbox is running and a session is established.
   */
  /** Locked version of ensureSupervisorInfra for external callers (IPC). */
  ensureSupervisorInfraLocked = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      await this.ensureSupervisorInfra(ticketId);
    });
  };

  ensureSupervisorInfra = async (
    ticketId: TicketId
  ): Promise<{ machine: TicketMachine; sandbox: AgentProcess | null }> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // Idempotent: if machine already exists with a running sandbox, ensure session and return
    const existing = this.machines.get(ticketId);
    if (existing) {
      const sbStatus = existing.sandbox?.getStatus();
      // Machine is using a Code tab sandbox (sandbox === null) — check if still viable
      const isRunning = existing.sandbox
        ? sbStatus?.type === 'running'
        : this.getCodeTabWsUrl(ticketId) !== null;

      if (isRunning) {
        const phase = existing.machine.getPhase();

        // Already streaming — don't interfere
        if (existing.machine.isStreaming()) {
          console.log(`[ProjectManager] ensureSupervisorInfra: machine ${ticketId} already streaming (${phase}), returning.`);
          return existing;
        }

        // Machine has a session and is ready — reuse as-is
        if (phase === 'ready' && existing.machine.getSessionId()) {
          console.log(`[ProjectManager] ensureSupervisorInfra: machine ${ticketId} already ready with session, returning.`);
          return existing;
        }

        // Machine is in a non-streaming state without a session — re-provision
        const wsUrl = (existing.sandbox && sbStatus?.type === 'running') ? sbStatus.data.wsUrl! : this.getCodeTabWsUrl(ticketId)!;
        console.log(`[ProjectManager] ensureSupervisorInfra: re-provisioning ${ticketId} from phase "${phase}".`);
        existing.machine.forcePhase('provisioning');
        existing.machine.setWsUrl(wsUrl);
        await this.ensureSession(ticketId);
        return existing;
      }
      // Existing sandbox not running — clean up stale machine and create fresh
      console.log(
        `[ProjectManager] ensureSupervisorInfra: stale machine for ${ticketId} (sandbox status: ${sbStatus?.type ?? 'unknown'}, phase: ${existing.machine.getPhase()}). Cleaning up.`
      );
      await existing.machine.dispose();
      this.machines.delete(ticketId);
    }

    // Check if a Code tab already has a running sandbox for this ticket.
    // If so, reuse it instead of spinning up a second container.
    const codeTabWsUrl = this.getCodeTabWsUrl(ticketId);
    if (codeTabWsUrl) {
      console.log(`[ProjectManager] ensureSupervisorInfra: reusing Code tab sandbox for ${ticketId} (ws: ${codeTabWsUrl})`);
      const machine = this.createMachine(ticketId);
      machine.transition('provisioning');

      // We don't own the sandbox — the Code tab's ProcessManager entry owns the lifecycle.
      this.machines.set(ticketId, { machine, sandbox: null });

      machine.setWsUrl(codeTabWsUrl);
      await this.ensureSession(ticketId);

      return { machine, sandbox: null };
    }

    // No Code tab sandbox available — create a dedicated supervisor sandbox.
    const machine = this.createMachine(ticketId);
    machine.transition('provisioning');

    // Deferred: resolves when sandbox becomes 'running'
    let resolveReady!: (wsUrl: string) => void;
    let rejectReady!: (err: Error) => void;
    const sandboxReady = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const startTimeout = setTimeout(() => {
      rejectReady(new Error('Sandbox start timeout (120s)'));
    }, 120_000);

    const resolvedWorkspace = await this.resolveTicketWorkspace(ticketId);
    let workspaceDir = resolvedWorkspace.workspaceDir;
    const taskId = nanoid();
    const { worktreePath, worktreeName, action } = resolvedWorkspace;

    // Run after_create hook only when a new worktree was created (not on reuse)
    if (action === 'create') {
      const afterCreateOk = await this.workflowLoader.runHook(ticket.projectId, 'after_create', workspaceDir);
      if (!afterCreateOk) {
        clearTimeout(startTimeout);
        if (worktreePath && worktreeName) {
          await removeWorktree(requireLocalWorkspaceDir(project.source), worktreePath, worktreeName);
        }
        machine.transition('error');
        throw new Error('after_create hook failed');
      }
    }

    const task: Task = {
      id: taskId,
      projectId: ticket.projectId,
      taskDescription: `Supervisor for: ${ticket.title}`,
      status: { type: 'starting', timestamp: Date.now() },
      createdAt: Date.now(),
      ticketId,
      branch: this.resolveTicketBranch(ticket),
      worktreePath,
      worktreeName,
    };

    const sandboxBackend = this.store.get('sandboxBackend') as import('@/shared/types').SandboxBackend | undefined;
    const platformClient = createPlatformClient(this.store.get('platform'));
    const mode: import('@/main/agent-process').AgentProcessMode =
      sandboxBackend === 'platform' ? 'platform'
      : sandboxBackend === 'docker' ? 'sandbox'
      : sandboxBackend === 'podman' ? 'podman'
      : sandboxBackend === 'vm' ? 'vm'
      : sandboxBackend === 'local' ? 'local'
      : 'none';
    const sandbox = new AgentProcess({
      mode,
      platformClient: platformClient ?? undefined,
      ipcRawOutput: () => {},
      onStatusChange: (status) => {
        const taskEntry = this.tasks.get(taskId);
        if (taskEntry) {
          const patch: Partial<Task> = { status };
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
        this.sendToWindow('project:task-status', taskId, status);

        // Forward to linked Code tab so the UI connects to the supervisor's sandbox
        // instead of launching a separate one.
        const codeTabs = this.store.get('codeTabs', []) as Array<{ id: string; ticketId?: string }>;
        const codeTab = codeTabs.find((t) => t.ticketId === ticketId);
        if (codeTab) {
          this.sendToWindow('agent-process:status', codeTab.id as CodeTabId, status);
        }

        // Resolve/reject the startup promise (only effective on first call)
        if (status.type === 'running') {
          resolveReady(status.data.wsUrl!);
        } else if (status.type === 'error') {
          rejectReady(new Error('Sandbox failed to start'));
        }
      },
    });

    this.tasks.set(taskId, { task, sandbox });
    this.persistTask(task);
    this.updateTicket(ticketId, { supervisorTaskId: taskId });

    this.machines.set(ticketId, { machine, sandbox });

    sandbox.start({
      workspaceDir,
      sandboxVariant: 'work',
      sandboxConfig: project.sandbox,
      gitRepo: resolvedWorkspace.gitRepo,
    });

    // Await sandbox readiness
    let wsUrl: string;
    try {
      wsUrl = await sandboxReady;
    } catch (error) {
      clearTimeout(startTimeout);
      machine.transition('error');
      throw error;
    }
    clearTimeout(startTimeout);

    // Set WS URL and ensure session
    machine.setWsUrl(wsUrl);
    await this.ensureSession(ticketId);

    return { machine, sandbox };
  };

  /** Return the supervisor sandbox status for a Code tab linked to a ticket. */
  getSupervisorStatusForCodeTab(tabId: CodeTabId): WithTimestamp<AgentProcessStatus> | null {
    const codeTabs = this.store.get('codeTabs', []) as Array<{ id: string; ticketId?: string }>;
    const tab = codeTabs.find((t) => t.id === tabId);
    if (!tab?.ticketId) return null;
    const entry = this.machines.get(tab.ticketId as TicketId);
    if (!entry?.sandbox) return null;
    return entry.sandbox.getStatus();
  }

  getTicketWorkspaceLocked = (ticketId: TicketId): Promise<string> => {
    return this.withTicketLock(ticketId, async () => {
      const resolved = await this.resolveTicketWorkspace(ticketId);
      return resolved.workspaceDir;
    });
  };

  /** Check if a Code tab has a running sandbox for this ticket. */
  private getCodeTabWsUrl(ticketId: TicketId): string | null {
    if (!this.processManager) return null;
    const codeTabs = this.store.get('codeTabs', []) as Array<{ id: string; ticketId?: string }>;
    return this.processManager.getRunningWsUrlForTicket(ticketId, codeTabs);
  }

  private resolveTicketWorkspace = async (ticketId: TicketId): Promise<{
    workspaceDir: string;
    worktreePath?: string;
    worktreeName?: string;
    action: 'reuse' | 'create' | 'none';
    /** For git-remote projects: repo info so the container can clone. */
    gitRepo?: { url: string; branch?: string };
  }> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      throw new Error(`Project not found: ${ticket.projectId}`);
    }

    // Git-remote projects: container clones the repo — no local workspace or worktrees
    if (project.source.kind === 'git-remote') {
      const effectiveBranch = this.resolveTicketBranch(ticket) ?? project.source.defaultBranch;
      return {
        workspaceDir: '/home/user/workspace', // container-side path (not local)
        action: 'none',
        gitRepo: {
          url: project.source.repoUrl,
          branch: effectiveBranch,
        },
      };
    }

    let workspaceDir = requireLocalWorkspaceDir(project.source);
    let worktreePath: string | undefined;
    let worktreeName: string | undefined;
    const effectiveBranch = this.resolveTicketBranch(ticket);

    let worktreeExists = false;
    if (ticket.worktreePath) {
      try {
        await fs.access(ticket.worktreePath);
        worktreeExists = true;
      } catch {
      }
    }

    const wtAction = decideWorktreeAction(ticket, worktreeExists, effectiveBranch);
    if (wtAction.action === 'reuse') {
      worktreePath = wtAction.worktreePath;
      worktreeName = wtAction.worktreeName;
      workspaceDir = worktreePath;
      console.log(`[ProjectManager] Reusing existing worktree "${worktreeName}" for ticket ${ticketId}`);
    } else if (wtAction.action === 'create') {
      worktreeName = generateWorktreeName();
      worktreePath = await createWorktree(requireLocalWorkspaceDir(project.source), effectiveBranch!, worktreeName);
      workspaceDir = worktreePath;
      this.updateTicket(ticketId, { worktreePath, worktreeName });
    }

    return {
      workspaceDir,
      worktreePath,
      worktreeName,
      action: wtAction.action,
    };
  };

  /**
   * Ensure a session exists for the ticket. Generates the session ID upfront
   * and persists it on the ticket BEFORE the RPC completes, so the renderer
   * can include ?session= in the embedded UI URL immediately (progressive load).
   */
  private ensureSession = async (ticketId: TicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) return;

    // If the machine is already in 'ready' state with a session, nothing to do
    const existingEntry = this.machines.get(ticketId);
    if (existingEntry?.machine.getPhase() === 'ready' && existingEntry.machine.getSessionId()) {
      return;
    }

    const entry = this.machines.get(ticketId);
    if (!entry) return;

    const variables = this.buildRunVariables(ticketId, 'interactive');

    const sessionId = crypto.randomUUID();

    try {
      console.log(`[ProjectManager] Creating session ${sessionId} for ticket ${ticketId}`);
      await entry.machine.createSession(variables, sessionId);
      console.log(`[ProjectManager] Session created: ${sessionId} for ticket ${ticketId}`);
      // Only publish the session ID after it actually exists in the server,
      // so the renderer's getSessionHistory call won't fail on a non-existent session.
      this.updateTicket(ticketId, { supervisorSessionId: sessionId });
    } catch (error) {
      console.error(`[ProjectManager] Failed to create session for ${ticketId}:`, error);
      // Clear the optimistic session ID since creation failed
      this.updateTicket(ticketId, { supervisorSessionId: undefined });
      // Recover from stuck connecting/session_creating phase so the UI doesn't show
      // "Connecting…" indefinitely. Reset to idle so the user can retry.
      const phase = entry.machine.getPhase();
      if (phase === 'connecting' || phase === 'session_creating') {
        entry.machine.forcePhase('idle');
      }
    }
  };

  /**
   * Dispatch preflight: validate that we can start a supervisor for this ticket.
   * Returns an error string if validation fails, or null if OK.
   */
  private validateDispatchPreflight = (ticketId: TicketId): string | null => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return `Ticket not found: ${ticketId}`;
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    if (!project) {
      return `Project not found: ${ticket.projectId}`;
    }

    if (project.source.kind === 'local' && !project.source.workspaceDir) {
      return `Project "${project.label}" has no workspace directory configured`;
    }
    if (project.source.kind === 'git-remote' && !project.source.repoUrl) {
      return `Project "${project.label}" has no repository URL configured`;
    }

    if (this.isTerminalColumn(ticket.projectId, ticket.columnId)) {
      return `Ticket is in terminal column "${ticket.columnId}" — cannot start supervisor`;
    }

    // Check machine to prevent duplicate dispatch — allow starting from 'ready' (manual session)
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      const phase = machineEntry.machine.getPhase();
      if (phase !== 'idle' && phase !== 'ready' && phase !== 'error' && phase !== 'completed') {
        return `Ticket ${ticketId} is already active (phase: ${phase})`;
      }
    }

    if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
      const columnLimit = this.getColumnMaxConcurrent(ticket.projectId, ticket.columnId);
      if (columnLimit !== undefined) {
        const columnCount = this.getRunningSupervisorCountByColumn(ticket.projectId, ticket.columnId);
        if (columnCount >= columnLimit) {
          return `Per-column concurrency limit reached for "${ticket.columnId}" (${columnCount}/${columnLimit})`;
        }
      }
      return `Concurrency limit reached (${MAX_CONCURRENT_SUPERVISORS} supervisors running). Stop another supervisor first.`;
    }

    // WIP limit check (cognitive limit, cross-project)
    const wipLimit = this.store.get('wipLimit') ?? 3;
    const activeWip = this.getActiveWipTickets();
    // Don't count the ticket itself if it's already active (e.g. retrying)
    const wipCount = activeWip.filter((t) => t.id !== ticketId).length;
    if (wipCount >= wipLimit) {
      return `WIP_LIMIT:${wipLimit}`;
    }

    return null;
  };

  /**
   * Build the full supervisor prompt, incorporating FLEET.md custom prompt if present.
   */
  private buildFullSupervisorPrompt = (ticketId: TicketId, attempt: number | null = null): string => {
    const ticket = this.getTicketById(ticketId)!;
    const project = this.getProjects().find((p) => p.id === ticket.projectId)!;
    const pipeline = this.getPipeline(ticket.projectId);

    const basePrompt = buildSupervisorPrompt(ticket, project, pipeline);
    const customPrompt = this.workflowLoader.getPromptTemplate(ticket.projectId);

    if (customPrompt) {
      let rendered = customPrompt;

      // Render template variables if the prompt contains {{ }} expressions
      if (hasTemplateExpressions(customPrompt)) {
        const vars: TemplateVariables = {
          ticket: {
            id: ticket.id,
            title: ticket.title,
            description: ticket.description || '(no description)',
            priority: ticket.priority,
            columnId: ticket.columnId,
            branch: this.resolveTicketBranch(ticket),
          },
          pipeline: {
            columns: pipeline.columns.map((c) => c.label).join(' → '),
          },
          project: {
            label: project.label,
            workspaceDir: project.source.kind === 'local' ? project.source.workspaceDir : project.source.repoUrl,
          },
          attempt,
        };

        try {
          rendered = renderTemplate(customPrompt, vars);
        } catch (err) {
          console.warn(`[ProjectManager] Template render failed for ${ticketId}: ${(err as Error).message}. Using raw prompt.`);
          rendered = customPrompt;
        }
      }

      return `${basePrompt}\n\n## Project-Specific Instructions (from FLEET.md)\n\n${rendered}`;
    }

    return basePrompt;
  };

  /**
   * Build the full variables object for a session or run RPC call.
   * Includes the supervisor prompt and client tool definitions so the agent
   * can call project tools via the existing WebSocket connection.
   *
   * - 'autopilot': ticket tools only (automated runs, retries, continuations)
   * - 'interactive': broader project-management tools for human-driven ticket sessions
   */
  private buildRunVariables = (ticketId: TicketId, mode: 'autopilot' | 'interactive' = 'autopilot'): Record<string, unknown> => {
    const ticket = this.getTicketById(ticketId);
    const opts = {
      projectId: ticket?.projectId,
      projectLabel: ticket ? this.getProjects().find((p) => p.id === ticket.projectId)?.label : undefined,
      ticketId,
    };
    const vars = mode === 'autopilot' ? buildAutopilotVariables(opts) : buildInteractiveVariables(opts);
    const supervisorPrompt = this.buildFullSupervisorPrompt(ticketId);
    const toolInstructions = (vars.additional_instructions as string) ?? '';
    return {
      ...vars,
      additional_instructions: toolInstructions
        ? `${supervisorPrompt}\n\n${toolInstructions}`
        : supervisorPrompt,
    };
  };

  /**
   * Build the continuation prompt for a supervisor run.
   * Uses custom prompt from FLEET.md if configured, otherwise the default.
   * Supports {{turn}} and {{maxTurns}} placeholders in custom prompts.
   */
  private buildContinuationPrompt(ticketId: TicketId, turn: number, maxTurns: number): string {
    const ticket = this.getTicketById(ticketId);
    const customContinuation = ticket
      ? this.workflowLoader.getConfig(ticket.projectId).supervisor?.continuation_prompt
      : undefined;

    const pipeline = ticket ? this.getPipeline(ticket.projectId) : null;
    const columnLabels = pipeline?.columns.map((c) => c.label).join(', ') ?? '';
    const currentColumn = pipeline?.columns.find((c) => c.id === ticket?.columnId)?.label ?? ticket?.columnId ?? '';

    if (customContinuation) {
      return customContinuation.replace(/\{\{turn}}/g, String(turn)).replace(/\{\{maxTurns}}/g, String(maxTurns));
    }

    return [
      'Continuation guidance:',
      '',
      `- The previous run completed normally, but the ticket may still have remaining work.`,
      `- This is continuation turn ${turn} of ${maxTurns}.`,
      `- Resume from current workspace state — do not restart from scratch or re-read files you already have in context.`,
      `- The original task instructions and prior context are already in this session, so do not restate them before acting.`,
      `- Use your best judgement to move the work forward. You are working in an isolated sandbox, so it is safe to make changes freely. Do not ask for confirmation or escalate to the user unless you are truly blocked on something that requires human input. The human will review your work at a later stage.`,
      `- Your ticket is currently in column "${currentColumn}". If you have completed the work, call \`move_ticket\` to advance it. Valid columns: ${columnLabels}.`,
      `- Before continuing, use \`add_ticket_comment\` to briefly record what you accomplished so far and what remains. This helps future runs (and humans) understand the state of work.`,
      `- Use \`notify\` to send the human a heads-up without stopping. Use \`escalate\` only when you truly cannot proceed without human input.`,
    ].join('\n');
  }

  /**
   * Start the autonomous supervisor — sends the full supervisor prompt as the user turn.
   * Triggered by the Play button.
   */
  startSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const preflightError = this.validateDispatchPreflight(ticketId);
      if (preflightError) {
        console.warn(`[ProjectManager] Dispatch preflight failed for ${ticketId}: ${preflightError}`);
        throw new Error(preflightError);
      }

      const ticket = this.getTicketById(ticketId)!;
      const project = this.getProjects().find((p) => p.id === ticket.projectId)!;

      // Load FLEET.md workflow (from local dir or git remote)
      if (project.source.kind === 'local') {
        await this.workflowLoader.load(ticket.projectId, project.source.workspaceDir);

        const hookOk = await this.workflowLoader.runHook(ticket.projectId, 'before_run', project.source.workspaceDir);
        if (!hookOk) {
          console.warn(`[ProjectManager] before_run hook failed for ${ticketId}. Aborting start.`);
          throw new Error('before_run hook failed');
        }
      } else {
        const effectiveBranch = this.resolveTicketBranch(ticket) ?? project.source.defaultBranch;
        await this.workflowLoader.loadFromRemote(ticket.projectId, project.source.repoUrl, effectiveBranch);
      }

      console.log(`[ProjectManager] startSupervisor: ensureSupervisorInfra for ${ticketId}...`);
      const { machine, sandbox } = await this.ensureSupervisorInfra(ticketId);
      console.log(`[ProjectManager] startSupervisor: ensureSupervisorInfra done. Phase: ${machine.getPhase()}, sessionId: ${machine.getSessionId()}`);

      // For git-remote projects, run before_run hook inside the container via sandbox exec
      if (project.source.kind === 'git-remote') {
        const hookScript = this.workflowLoader.getConfig(ticket.projectId).hooks?.before_run;
        if (hookScript && sandbox) {
          const hookOk = await sandbox.execInContainer(hookScript, '/home/user/workspace');
          if (!hookOk) {
            console.warn(`[ProjectManager] before_run hook failed in container for ${ticketId}. Aborting start.`);
            throw new Error('before_run hook failed');
          }
        }
      }

      // Use the session ID from the machine (may have been freshly created by ensureSupervisorInfra)
      const sessionId = machine.getSessionId() ?? undefined;
      const variables = this.buildRunVariables(ticketId);
      console.log(`[ProjectManager] startSupervisor: calling startMachineRun for ${ticketId} (sessionId: ${sessionId})`);
      this.startMachineRun(ticketId, 'Begin working on this ticket.', { sessionId, variables });
    });
  };

  private startMachineRun = (
    ticketId: TicketId,
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): void => {
    const entry = this.machines.get(ticketId);
    if (!entry) {
      console.warn(`[ProjectManager] startMachineRun: no machine entry for ${ticketId}`);
      return;
    }

    console.log(`[ProjectManager] startMachineRun: starting run for ${ticketId} (phase: ${entry.machine.getPhase()})`);
    void entry.machine.startRun(prompt, { sessionId: opts?.sessionId, variables: opts?.variables }).then(
      (result) => {
        this.updateTicket(ticketId, { supervisorSessionId: result.sessionId });
      },
      (error) => {
        console.error(`[ProjectManager] Machine start failed for ${ticketId}:`, error);
        // Ensure machine transitions to error if startRun didn't already
        if (entry.machine.isActive() && entry.machine.getPhase() !== 'error') {
          entry.machine.transition('error');
        }
      }
    );
  };

  stopSupervisor = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) return;

      await entry.machine.stop();
    });
  };

  /**
   * Clean up a ticket's workspace: stop and remove its container, delete its worktree,
   * and run the before_remove hook. Called when a ticket reaches a terminal column.
   */
  private cleanupTicketWorkspace = async (ticketId: TicketId): Promise<void> => {
    const ticket = this.getTicketById(ticketId);
    if (!ticket) {
      return;
    }

    const project = this.getProjects().find((p) => p.id === ticket.projectId);
    const taskId = ticket.supervisorTaskId;

    // Run before_remove hook
    if (project?.source.kind === 'local') {
      const workspaceDir = ticket.worktreePath ?? project.source.workspaceDir;
      await this.workflowLoader.runHook(ticket.projectId, 'before_remove', workspaceDir);
    } else if (project?.source.kind === 'git-remote') {
      const hookScript = this.workflowLoader.getConfig(ticket.projectId).hooks?.before_remove;
      if (hookScript) {
        const machineEntry = this.machines.get(ticketId);
        if (machineEntry?.sandbox) {
          await machineEntry.sandbox.execInContainer(hookScript, '/home/user/workspace');
        }
      }
    }

    // Dispose machine if still registered
    const machineEntry = this.machines.get(ticketId);
    if (machineEntry) {
      await machineEntry.machine.dispose();
      this.machines.delete(ticketId);
    }

    // Stop and exit the container
    if (taskId) {
      const taskEntry = this.tasks.get(taskId);
      if (taskEntry) {
        await taskEntry.sandbox.exit();
        this.tasks.delete(taskId);
      }
      this.removePersistedTask(taskId);
    }

    // Remove worktree (source of truth is the ticket, not the task)
    if (ticket.worktreePath && ticket.worktreeName && project && project.source.kind === 'local') {
      await removeWorktree(project.source.workspaceDir, ticket.worktreePath, ticket.worktreeName);
      this.updateTicket(ticketId, { worktreePath: undefined, worktreeName: undefined });
    }

    console.log(`[ProjectManager] Cleaned up workspace for ticket ${ticketId}.`);
  };

  resetSupervisorSession = (ticketId: TicketId): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) return;

      await entry.machine.stop();

      // Build fresh variables (includes FLEET.md custom prompt + client tools)
      const variables = this.buildRunVariables(ticketId, 'interactive');

      // Ensure WS URL is set
      if (entry.sandbox) {
        const sbStatus = entry.sandbox.getStatus();
        if (sbStatus?.type === 'running' && sbStatus.data.wsUrl) {
          entry.machine.setWsUrl(sbStatus.data.wsUrl);
        }
      } else {
        const wsUrl = this.getCodeTabWsUrl(ticketId);
        if (wsUrl) entry.machine.setWsUrl(wsUrl);
      }

      // Create a new session, then update the ticket so the renderer
      // only switches to the new session URL after it actually exists.
      const newSessionId = crypto.randomUUID();
      await entry.machine.createSession(variables, newSessionId);
      this.updateTicket(ticketId, { supervisorSessionId: newSessionId });
    });
  };

  sendSupervisorMessage = (ticketId: TicketId, message: string): Promise<void> => {
    return this.withTicketLock(ticketId, async () => {
      const entry = this.machines.get(ticketId);
      if (!entry) {
        // No active machine — check concurrency before spinning up
        const ticket = this.getTicketById(ticketId);
        if (!ticket) {
          throw new Error(`Ticket not found: ${ticketId}`);
        }
        if (!this.canStartSupervisor(ticket.projectId, ticket.columnId)) {
          throw new Error('Concurrency limit reached');
        }

        await this.ensureSupervisorInfra(ticketId);
        await this.sendUserRunMessage(ticketId, message);
        return;
      }

      const phase = entry.machine.getPhase();

      if (phase === 'idle' || phase === 'error' || phase === 'ready' || phase === 'awaiting_input') {
        await this.sendUserRunMessage(ticketId, message);
      } else if (entry.machine.isStreaming()) {
        try {
          await entry.machine.sendMessage(message);
        } catch (error) {
          console.error(`[ProjectManager] Machine send_user_message failed for ${ticketId}:`, error);
        }
      }
    });
  };

  /**
   * Start a run with the user's message as the prompt.
   */
  private sendUserRunMessage = async (ticketId: TicketId, message: string): Promise<void> => {
    const entry = this.machines.get(ticketId);
    if (!entry) return;

    if (entry.sandbox) {
      const sbStatus = entry.sandbox.getStatus();
      if (sbStatus?.type === 'running' && sbStatus.data.wsUrl) {
        entry.machine.setWsUrl(sbStatus.data.wsUrl);
      }
    } else {
      const wsUrl = this.getCodeTabWsUrl(ticketId);
      if (wsUrl) entry.machine.setWsUrl(wsUrl);
    }

    const sessionId = entry.machine.getSessionId() ?? undefined;

    const ticket = this.getTicketById(ticketId);
    const variables = ticket ? this.buildRunVariables(ticketId, 'interactive') : undefined;

    try {
      const result = await entry.machine.startRun(message, { sessionId, variables });
      this.updateTicket(ticketId, { supervisorSessionId: result.sessionId });
    } catch (error) {
      console.error(`[ProjectManager] Machine message failed for ${ticketId}:`, error);
    }
  };

  // #endregion

  // #region Task persistence

  private getPersistedTasks = (): Task[] => {
    return this.store.get('tasks', []);
  };

  private setPersistedTasks = (tasks: Task[]): void => {
    this.store.set('tasks', tasks);
    this.sendToWindow('store:changed', this.store.store);
  };

  private persistTask = (task: Task): void => {
    const tasks = this.getPersistedTasks();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index === -1) {
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    this.setPersistedTasks(tasks);
  };

  private removePersistedTask = (taskId: TaskId): void => {
    const tasks = this.getPersistedTasks().filter((t) => t.id !== taskId);
    this.setPersistedTasks(tasks);
  };

  restorePersistedTasks = (): void => {
    const tasks = this.getPersistedTasks();
    const updated: Task[] = [];
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

    // Startup sweep: clean up stale workspaces for tickets already in terminal columns
    void this.startupTerminalCleanup();
  };

  /**
   * Startup sweep: find persisted tasks whose tickets are in terminal columns
   * and clean up their worktrees. Prevents stale workspaces from accumulating after restarts.
   */
  private startupTerminalCleanup = async (): Promise<void> => {
    const tickets = this.getTickets();
    let cleaned = 0;

    for (const ticket of tickets) {
      if (!this.isTerminalColumn(ticket.projectId, ticket.columnId)) {
        continue;
      }

      // Clean up worktree from the ticket
      if (ticket.worktreePath && ticket.worktreeName) {
        const project = this.getProjects().find((p) => p.id === ticket.projectId);
        if (project?.source.kind === 'local') {
          await removeWorktree(project.source.workspaceDir, ticket.worktreePath, ticket.worktreeName);
        }
        this.updateTicket(ticket.id, { worktreePath: undefined, worktreeName: undefined });
        cleaned++;
      }

      // Clean up orphaned task record
      if (ticket.supervisorTaskId) {
        this.removePersistedTask(ticket.supervisorTaskId);
      }
    }

    // Also clean up orphaned tasks with no matching ticket
    const tasks = this.getPersistedTasks();
    const ticketIds = new Set(tickets.map((t) => t.id));
    for (const task of tasks) {
      if (task.ticketId && !ticketIds.has(task.ticketId)) {
        if (task.worktreePath && task.worktreeName) {
          const project = this.getProjects().find((p) => p.id === task.projectId);
          if (project?.source.kind === 'local') {
            await removeWorktree(project.source.workspaceDir, task.worktreePath, task.worktreeName);
          }
        }
        this.removePersistedTask(task.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[ProjectManager] Startup cleanup: removed ${cleaned} stale workspace(s) for terminal tickets.`);
    }
  };

  private resetStaleTicketStates = (): void => {
    const tickets = this.getTickets();
    let dirty = false;
    const patched = tickets.map((ticket) => {
      // On startup, reset everything except 'idle' and 'completed' back to 'idle'.
      // Error states from previous sessions are stale — the infrastructure is gone,
      // so presenting old errors on fresh launch is confusing. Only 'completed'
      // persists because the work is actually done.
      if (ticket.phase && ticket.phase !== 'idle' && ticket.phase !== 'completed') {
        dirty = true;
        return { ...ticket, phase: 'idle' as const };
      }
      return ticket;
    });

    if (dirty) {
      this.setTickets(patched);
    }
  };

  // #endregion

  // #region Task session initialization

  private initializeTaskSession = async (taskId: TaskId, wsUrl: string, prompt: string): Promise<void> => {
    try {
      const sessionId = await sendStartRun(wsUrl, prompt);
      const existing = this.tasks.get(taskId);
      if (existing) {
        existing.task = { ...existing.task, sessionId };
        this.persistTask(existing.task);
        this.sendToWindow('project:task-session', taskId, sessionId);
      }
    } catch (error) {
      console.warn(`Failed to initialize task session for ${taskId}: ${(error as Error).message}`);
    }
  };

  // #endregion

  // #region Tasks (in-memory sandboxes + persisted records)

  private stopTask = async (taskId: TaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }

    // If this task belongs to a machine, stop it too
    if (entry.task.ticketId) {
      const machineEntry = this.machines.get(entry.task.ticketId);
      if (machineEntry) {
        await this.stopSupervisor(entry.task.ticketId);
      }
    }

    await entry.sandbox.stop();
  };

  private removeTask = async (taskId: TaskId): Promise<void> => {
    const entry = this.tasks.get(taskId);
    if (!entry) {
      return;
    }

    // If this task belongs to a machine, clean it up
    if (entry.task.ticketId) {
      const machineEntry = this.machines.get(entry.task.ticketId);
      if (machineEntry) {
        await machineEntry.machine.dispose();
        this.machines.delete(entry.task.ticketId);
      }
    }

    await entry.sandbox.exit();

    // Remove worktree — check ticket first (source of truth), fall back to task
    if (entry.task.ticketId) {
      const ticket = this.getTicketById(entry.task.ticketId);
      if (ticket?.worktreePath && ticket.worktreeName) {
        const project = this.getProjects().find((p) => p.id === ticket.projectId);
        if (project?.source.kind === 'local') {
          await removeWorktree(project.source.workspaceDir, ticket.worktreePath, ticket.worktreeName);
        }
        this.updateTicket(ticket.id, { worktreePath: undefined, worktreeName: undefined });
      }
    } else if (entry.task.worktreePath && entry.task.worktreeName) {
      const project = this.getProjects().find((p) => p.id === entry.task.projectId);
      if (project?.source.kind === 'local') {
        await removeWorktree(project.source.workspaceDir, entry.task.worktreePath, entry.task.worktreeName);
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
    const version = store.get('schemaVersion', 0);

    // v3 → v4: replace supervisorStatus + runPhase with phase
    if (version === 3) {
      console.log('[ProjectManager] Migrating to phase schema (→ v4)');
      const tickets = store.get('tickets', []) as Record<string, unknown>[];
      const migrated = tickets.map((raw) => {
        const { supervisorStatus, runPhase, ...rest } = raw;
        return { ...rest, phase: 'idle' };
      });
      store.set('tickets', migrated);
      store.set('schemaVersion', 4);
      console.log(`[ProjectManager] v4 migration complete: ${migrated.length} tickets`);
      // Fall through to v4→v5 migration
    }

    // v4 → v5: create default initiatives per project, assign tickets
    if (version === 4 || store.get('schemaVersion', 0) === 4) {
      console.log('[ProjectManager] Migrating to initiative schema (→ v5)');
      const projects = store.get('projects', []) as Array<{ id: string }>;
      const tickets = store.get('tickets', []) as Record<string, unknown>[];

      const initiatives: Initiative[] = [];
      const projectToDefaultInitiative = new Map<string, string>();

      for (const proj of projects) {
        const initId = nanoid();
        projectToDefaultInitiative.set(proj.id, initId);
        const now = Date.now();
        initiatives.push({
          id: initId,
          projectId: proj.id,
          title: 'General',
          description: 'Default initiative',
          status: 'active',
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        });
      }

      const migratedTickets = tickets.map((raw) => ({
        ...raw,
        initiativeId: projectToDefaultInitiative.get(raw.projectId as string) ?? '',
      }));

      store.set('initiatives', initiatives);
      store.set('tickets', migratedTickets);
      store.set('schemaVersion', 5);
      console.log(
        `[ProjectManager] v5 migration complete: ${initiatives.length} initiatives, ${migratedTickets.length} tickets`
      );
      return;
    }

    // v5 → v6: migrate inbox 'deferred' status to 'iceboxed', add wipLimit
    if (version === 5 || store.get('schemaVersion', 0) === 5) {
      console.log('[ProjectManager] Migrating inbox deferred → iceboxed, adding wipLimit (→ v6)');
      const inboxItems = store.get('inboxItems', []) as Record<string, unknown>[];
      const migratedInbox = inboxItems.map((item) => ({
        ...item,
        status: (item.status as string) === 'deferred' ? 'iceboxed' : item.status,
      }));
      store.set('inboxItems', migratedInbox);
      if (store.get('wipLimit') === undefined) {
        store.set('wipLimit', 3);
      }
      store.set('schemaVersion', 6);
      console.log(`[ProjectManager] v6 migration complete: ${migratedInbox.length} inbox items`);
      return;
    }

    // v6 → v7: migrate Project.workspaceDir to Project.source
    if (version === 6 || store.get('schemaVersion', 0) === 6) {
      console.log('[ProjectManager] Migrating projects to ProjectSource (→ v7)');
      const projects = store.get('projects', []) as Record<string, unknown>[];
      const migrated = projects.map((raw) => {
        // Already migrated (defensive)
        if (raw.source && typeof raw.source === 'object') return raw;
        const { workspaceDir, ...rest } = raw;
        return {
          ...rest,
          source: { kind: 'local', workspaceDir: workspaceDir as string },
        };
      });
      store.set('projects', migrated);
      store.set('schemaVersion', 7);
      console.log(`[ProjectManager] v7 migration complete: ${migrated.length} projects`);
      return;
    }

    if (version >= 7) {
      return;
    }

    console.log('[ProjectManager] Migrating to supervisor schema (→ v3)');

    const tickets = store.get('tickets', []) as Record<string, unknown>[];
    const migrated: Record<string, unknown>[] = [];

    for (const raw of tickets) {
      // Strip all legacy fields and normalize (initiativeId added in v5 migration)
      const ticket: Record<string, unknown> = {
        id: (raw.id as string) ?? nanoid(),
        projectId: (raw.projectId as string) ?? '',
        title: (raw.title as string) ?? '',
        description: (raw.description as string) ?? '',
        priority: (raw.priority as TicketPriority) ?? 'medium',
        blockedBy: (raw.blockedBy as TicketId[]) ?? [],
        createdAt: (raw.createdAt as number) ?? Date.now(),
        updatedAt: (raw.updatedAt as number) ?? Date.now(),
        columnId: (raw.columnId as ColumnId) ?? 'backlog',
      };

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

    store.set('tickets', migrated);
    store.set('schemaVersion', 4);
    console.log(`[ProjectManager] Migration complete: ${migrated.length} tickets migrated`);
    // Re-enter to run v4→v5 migration
    ProjectManager.migrateToSupervisor(store);
  }

  // #endregion

  // #region Session history

  getSessionHistory = async (sessionId: string): Promise<SessionMessage[]> => {
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
      const messages: SessionMessage[] = [];

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
      console.error('[ProjectManager] Failed to query session history:', err);
      return [];
    }
  };

  // #endregion

  // #region Auto-dispatch (Symphony-inspired polling)

  /** Auto-dispatch poll interval — check every 30s for eligible tickets. */
  private static AUTO_DISPATCH_INTERVAL_MS = 30_000;

  private startAutoDispatch = (): void => {
    this.autoDispatchTimer = setInterval(() => this.autoDispatchTick(), ProjectManager.AUTO_DISPATCH_INTERVAL_MS);
  };

  /**
   * Set auto-dispatch on/off for a project. Persists the setting on the project.
   */
  setAutoDispatch = (projectId: ProjectId, enabled: boolean): void => {
    this.updateProject(projectId, { autoDispatch: enabled });
    if (enabled) {
      // Fire an immediate tick when enabling
      void this.autoDispatchTick();
    }
  };

  /**
   * One auto-dispatch tick: for each project with auto-dispatch enabled,
   * find the next eligible ticket and start its supervisor.
   */
  private autoDispatchTick = async (): Promise<void> => {
    const projects = this.getProjects();

    for (const project of projects) {
      if (!this.isAutoDispatchEnabled(project.id)) {
        continue;
      }

      // Check if we have global capacity
      if (this.getRunningSupervisorCount() >= MAX_CONCURRENT_SUPERVISORS) {
        break;
      }

      // Find the next eligible ticket (priority-sorted, not blocked, in backlog)
      const nextTicket = this.getNextTicket(project.id);
      if (!nextTicket) {
        continue;
      }

      // Skip if already active
      const machineEntry = this.machines.get(nextTicket.id);
      if (machineEntry && machineEntry.machine.isActive()) {
        continue;
      }

      // Move from first column to second column (first active column) to start work
      const pipeline = this.getPipeline(project.id);
      const firstColumnId = this.getFirstColumnId(project.id);
      const terminalColumnId = this.getTerminalColumnId(project.id);
      const firstActiveColumn = pipeline.columns.find((c) => c.id !== firstColumnId && c.id !== terminalColumnId);
      if (firstActiveColumn) {
        this.moveTicketToColumn(nextTicket.id, firstActiveColumn.id);
      }

      try {
        console.log(
          `[ProjectManager] Auto-dispatching ticket ${nextTicket.id} ("${nextTicket.title}") for project ${project.label}`
        );
        await this.startSupervisor(nextTicket.id);
      } catch (error) {
        console.warn(`[ProjectManager] Auto-dispatch failed for ${nextTicket.id}:`, (error as Error).message);
      }
    }
  };

  // #endregion

  exit = async (): Promise<void> => {
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
    if (this.autoDispatchTimer) {
      clearInterval(this.autoDispatchTimer);
      this.autoDispatchTimer = null;
    }
    if (this.inboxSweepTimer) {
      clearInterval(this.inboxSweepTimer);
      this.inboxSweepTimer = null;
    }
    this.cancelAllRetries();
    this.workflowLoader.dispose();

    // Dispose all machines
    for (const [ticketId, entry] of this.machines) {
      await entry.machine.dispose();
      this.machines.delete(ticketId);
    }

    const exits = [...this.tasks.values()].map((entry) => entry.sandbox.exit());
    await Promise.allSettled(exits);
    this.tasks.clear();
  };
}

export const createProjectManager = (arg: {
  ipc: IpcListener<IpcEvents>;
  sendToWindow: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  store: Store<StoreData>;
  processManager?: ProcessManager;
}) => {
  const { ipc, sendToWindow, store, processManager } = arg;

  // Run migration
  ProjectManager.migrateToSupervisor(store);

  const projectManager = new ProjectManager({ store, sendToWindow, processManager });
  projectManager.restorePersistedTasks();

  // Project handlers
  ipc.handle('project:add-project', (_, project) => projectManager.addProject(project));
  ipc.handle('project:update-project', (_, id, patch) => projectManager.updateProject(id, patch));
  ipc.handle('project:remove-project', (_, id) => projectManager.removeProject(id));
  ipc.handle('project:check-git-repo', (_, workspaceDir) => checkGitRepo(workspaceDir));

  // Ticket handlers
  ipc.handle('project:add-ticket', (_, ticket) => projectManager.addTicket(ticket));
  ipc.handle('project:update-ticket', (_, id, patch) => projectManager.updateTicket(id, patch));
  ipc.handle('project:remove-ticket', (_, id) => projectManager.removeTicket(id));
  ipc.handle('project:get-tickets', (_, projectId) => projectManager.getTicketsByProject(projectId));
  ipc.handle('project:get-ticket-workspace', (_, ticketId) => projectManager.getTicketWorkspaceLocked(ticketId));
  ipc.handle('project:get-tasks', () => projectManager.getTasks());
  ipc.handle('project:get-next-ticket', (_, projectId) => projectManager.getNextTicket(projectId));

  // Kanban
  ipc.handle('project:move-ticket-to-column', (_, ticketId, columnId) =>
    projectManager.moveTicketToColumn(ticketId, columnId)
  );
  ipc.handle('project:resolve-ticket', (_, ticketId, resolution) =>
    projectManager.resolveTicket(ticketId, resolution)
  );
  ipc.handle('project:get-pipeline', async (_, projectId) => {
    await projectManager.ensureWorkflowLoaded(projectId);
    return projectManager.getPipeline(projectId);
  });

  // Session history
  ipc.handle('project:get-session-history', (_, sessionId) => projectManager.getSessionHistory(sessionId));

  // Artifacts
  ipc.handle('project:list-artifacts', (_, ticketId, dirPath) => projectManager.listArtifacts(ticketId, dirPath));
  ipc.handle('project:read-artifact', (_, ticketId, relativePath) => projectManager.readArtifact(ticketId, relativePath));
  ipc.handle('project:open-artifact-external', (_, ticketId, relativePath) =>
    projectManager.openArtifactExternal(ticketId, relativePath)
  );
  ipc.handle('project:get-files-changed', (_, ticketId) => projectManager.getFilesChanged(ticketId));

  // Supervisor handlers
  ipc.handle('project:ensure-supervisor-infra', async (_, ticketId) => {
    await projectManager.ensureSupervisorInfraLocked(ticketId);
  });
  ipc.handle('project:start-supervisor', (_, ticketId) => projectManager.startSupervisor(ticketId));
  ipc.handle('project:stop-supervisor', (_, ticketId) => projectManager.stopSupervisor(ticketId));
  ipc.handle('project:send-supervisor-message', (_, ticketId, message) =>
    projectManager.sendSupervisorMessage(ticketId, message)
  );
  ipc.handle('project:reset-supervisor-session', (_, ticketId) => projectManager.resetSupervisorSession(ticketId));
  ipc.handle('project:set-auto-dispatch', (_, projectId, enabled) =>
    projectManager.setAutoDispatch(projectId, enabled)
  );
  ipc.handle('project:get-supervisor-sandbox-status', (_, tabId) =>
    projectManager.getSupervisorStatusForCodeTab(tabId)
  );
  ipc.handle('project:get-active-wip-tickets', () => projectManager.getActiveWipTickets());

  // Inbox handlers
  ipc.handle('inbox:get-items', () => projectManager.getInboxItemList());
  ipc.handle('inbox:add-item', (_, item) => projectManager.addInboxItem(item));
  ipc.handle('inbox:update-item', (_, id, patch) => projectManager.updateInboxItem(id, patch));
  ipc.handle('inbox:remove-item', (_, id) => projectManager.removeInboxItem(id));
  ipc.handle('inbox:get-icebox-items', () => projectManager.getIceboxItems());
  ipc.handle('inbox:restore-from-icebox', (_, id) => projectManager.restoreFromIcebox(id));
  ipc.handle('inbox:shape-item', (_, id, shaping) => projectManager.shapeInboxItem(id, shaping));
  ipc.handle('inbox:convert-to-ticket', (_, id, projectId) => projectManager.convertInboxToTicket(id, projectId));

  // Initiatives
  ipc.handle('initiative:get-items', (_, projectId) => projectManager.getInitiativesByProject(projectId));
  ipc.handle('initiative:add-item', (_, item) => projectManager.addInitiative(item));
  ipc.handle('initiative:update-item', (_, id, patch) => projectManager.updateInitiative(id, patch));
  ipc.handle('initiative:remove-item', (_, id) => projectManager.removeInitiative(id));

  const cleanup = async () => {
    await projectManager.exit();
    ipcMain.removeHandler('project:add-project');
    ipcMain.removeHandler('project:update-project');
    ipcMain.removeHandler('project:remove-project');
    ipcMain.removeHandler('project:check-git-repo');
    ipcMain.removeHandler('project:add-ticket');
    ipcMain.removeHandler('project:update-ticket');
    ipcMain.removeHandler('project:remove-ticket');
    ipcMain.removeHandler('project:get-tickets');
    ipcMain.removeHandler('project:get-ticket-workspace');
    ipcMain.removeHandler('project:get-next-ticket');
    ipcMain.removeHandler('project:move-ticket-to-column');
    ipcMain.removeHandler('project:get-pipeline');
    ipcMain.removeHandler('project:get-session-history');
    ipcMain.removeHandler('project:list-artifacts');
    ipcMain.removeHandler('project:read-artifact');
    ipcMain.removeHandler('project:open-artifact-external');
    ipcMain.removeHandler('project:get-files-changed');
    ipcMain.removeHandler('project:ensure-supervisor-infra');
    ipcMain.removeHandler('project:start-supervisor');
    ipcMain.removeHandler('project:stop-supervisor');
    ipcMain.removeHandler('project:send-supervisor-message');
    ipcMain.removeHandler('project:reset-supervisor-session');
    ipcMain.removeHandler('project:set-auto-dispatch');
    ipcMain.removeHandler('project:get-supervisor-sandbox-status');
    ipcMain.removeHandler('project:get-active-wip-tickets');
    ipcMain.removeHandler('inbox:get-items');
    ipcMain.removeHandler('inbox:add-item');
    ipcMain.removeHandler('inbox:update-item');
    ipcMain.removeHandler('inbox:remove-item');
    ipcMain.removeHandler('inbox:get-icebox-items');
    ipcMain.removeHandler('inbox:restore-from-icebox');
    ipcMain.removeHandler('inbox:shape-item');
    ipcMain.removeHandler('inbox:convert-to-ticket');
    ipcMain.removeHandler('initiative:get-items');
    ipcMain.removeHandler('initiative:add-item');
    ipcMain.removeHandler('initiative:update-item');
    ipcMain.removeHandler('initiative:remove-item');
  };

  return [projectManager, cleanup] as const;
};
