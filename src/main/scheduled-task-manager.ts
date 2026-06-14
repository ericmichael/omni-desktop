import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type Store from 'electron-store';
import { WebSocket as WsWebSocket } from 'ws';

import { mostRecentMissedScheduledTaskRun, nextScheduledTaskRun } from '@/lib/scheduled-task-schedule';
import type { ProcessManager } from '@/main/process-manager';
import { ensureDirectory } from '@/main/util';
import { getLocalWorkspaceDir } from '@/shared/project-source';
import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  IpcRendererEvents,
  Project,
  ScheduledTask,
  ScheduledTaskAllowedMcpTool,
  ScheduledTaskInput,
  ScheduledTaskPermissionMode,
  ScheduledTaskRun,
  ScheduledTaskUpdate,
  StoreData,
} from '@/shared/types';
import { firstSource } from '@/shared/types';

const TICK_MS = 60_000;
const HISTORY_LIMIT = 25;
const START_TIMEOUT_MS = 120_000;
const RPC_TIMEOUT_MS = 10_000;
const DEFAULT_PERMISSION_MODE: ScheduledTaskPermissionMode = 'ask';

type ScheduledTaskStore = Pick<Store<StoreData>, 'get' | 'set'>;

type StartRunResult = {
  runId?: string;
  sessionId?: string;
};

type RunEndResult = {
  runId?: string;
  sessionId?: string;
  reason?: string;
};

type StartRunWatcher = StartRunResult & {
  close: () => void;
};

type SafeToolOverrides = {
  safe_tool_names?: string[];
  safe_mcp_tools?: { server_label: string; tool_name: string }[];
};

type StartRunOptions = {
  safeToolOverrides?: SafeToolOverrides;
};

type ApprovalRequest = {
  kind: 'function' | 'mcp';
  toolName?: string;
  serverLabel?: string;
};

type ManagerDeps = {
  store: ScheduledTaskStore;
  processManager: ProcessManager;
  getProjects: () => Project[];
  sendToWindow?: <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;
  now?: () => number;
};

type NotifiableRunStatus = Extract<
  ScheduledTaskRun['status'],
  'running' | 'waiting_for_approval' | 'completed' | 'failed'
>;

export class ScheduledTaskManager {
  private store: ScheduledTaskStore;
  private processManager: ProcessManager;
  private getProjects: () => Project[];
  private sendToWindow?: ManagerDeps['sendToWindow'];
  private now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private launching = new Set<string>();
  private completing = new Set<string>();

  constructor(deps: ManagerDeps) {
    this.store = deps.store;
    this.processManager = deps.processManager;
    this.getProjects = deps.getProjects;
    this.sendToWindow = deps.sendToWindow;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.recomputeNextRuns();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(): ScheduledTask[] {
    return this.tasks();
  }

  create(input: ScheduledTaskInput): ScheduledTask {
    const now = this.now();
    const task: ScheduledTask = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      instructions: input.instructions.trim(),
      schedule: input.schedule,
      permissionMode: input.permissionMode ?? DEFAULT_PERMISSION_MODE,
      enabled: input.enabled ?? true,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.profileName ? { profileName: input.profileName } : {}),
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.enabled === false ? null : nextScheduledTaskRun(input.schedule, now),
      allowedToolNames: [],
      allowedMcpTools: [],
      history: [],
    };
    validateTask(task);
    this.writeTasks([...this.tasks(), task]);
    return task;
  }

  update(taskId: string, patch: ScheduledTaskUpdate): ScheduledTask {
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const prior = tasks[index];
    if (!prior) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const next: ScheduledTask = { ...prior, updatedAt: this.now() };
    if (patch.name !== undefined) {
      next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      next.description = patch.description.trim();
    }
    if (patch.instructions !== undefined) {
      next.instructions = patch.instructions.trim();
    }
    if (patch.schedule !== undefined) {
      next.schedule = patch.schedule;
    }
    next.permissionMode = patch.permissionMode ?? prior.permissionMode ?? DEFAULT_PERMISSION_MODE;
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled;
    }
    if (patch.projectId !== undefined) {
      next.projectId = patch.projectId;
    }
    if (patch.profileName !== undefined) {
      next.profileName = patch.profileName;
    }
    validateTask(next);
    next.nextRunAt = next.enabled ? nextScheduledTaskRun(next.schedule, this.now()) : null;
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
    return next;
  }

  delete(taskId: string): void {
    this.writeTasks(this.tasks().filter((task) => task.id !== taskId));
  }

  runNow(taskId: string): ScheduledTask {
    const task = this.tasks().find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    void this.fireTask(task, this.now(), 'manual');
    return task;
  }

  allowTool(taskId: string, toolName: string): ScheduledTask {
    const normalized = normalizeToolName(toolName);
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0 || !tasks[index]) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const prior = tasks[index];
    if ((prior.allowedToolNames ?? []).includes(normalized)) {
      return prior;
    }
    const next: ScheduledTask = {
      ...prior,
      allowedToolNames: [...(prior.allowedToolNames ?? []), normalized].sort((a, b) => a.localeCompare(b)),
      updatedAt: this.now(),
    };
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
    return next;
  }

  revokeTool(taskId: string, toolName: string): ScheduledTask {
    const normalized = normalizeToolName(toolName);
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0 || !tasks[index]) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const prior = tasks[index];
    const next: ScheduledTask = {
      ...prior,
      allowedToolNames: (prior.allowedToolNames ?? []).filter((item) => item !== normalized),
      updatedAt: this.now(),
    };
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
    return next;
  }

  allowMcpTool(taskId: string, tool: ScheduledTaskAllowedMcpTool): ScheduledTask {
    const normalized = normalizeMcpTool(tool);
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0 || !tasks[index]) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const prior = tasks[index];
    if ((prior.allowedMcpTools ?? []).some((item) => sameMcpTool(item, normalized))) {
      return prior;
    }
    const next: ScheduledTask = {
      ...prior,
      allowedMcpTools: normalizeMcpTools([...(prior.allowedMcpTools ?? []), normalized]),
      updatedAt: this.now(),
    };
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
    return next;
  }

  revokeMcpTool(taskId: string, tool: ScheduledTaskAllowedMcpTool): ScheduledTask {
    const normalized = normalizeMcpTool(tool);
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0 || !tasks[index]) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    const prior = tasks[index];
    const next: ScheduledTask = {
      ...prior,
      allowedMcpTools: normalizeMcpTools(prior.allowedMcpTools).filter((item) => !sameMcpTool(item, normalized)),
      updatedAt: this.now(),
    };
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
    return next;
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      for (const task of this.tasks()) {
        if (!task.enabled || task.schedule.kind === 'manual') {
          continue;
        }
        if (task.nextRunAt && task.nextRunAt <= now) {
          const missedRunAt = mostRecentMissedScheduledTaskRun(task.schedule, task.nextRunAt, now);
          if (missedRunAt !== null) {
            await this.fireTask(task, missedRunAt, 'scheduled');
          } else {
            this.patchTask(task.id, {
              nextRunAt: nextScheduledTaskRun(task.schedule, now),
              history: this.prependHistory(task, {
                id: randomUUID(),
                scheduledFor: task.nextRunAt,
                startedAt: now,
                status: 'skipped',
                reason: 'missed_window',
              }),
            });
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fireTask(task: ScheduledTask, scheduledFor: number, reason: 'scheduled' | 'manual'): Promise<void> {
    const current = this.getTask(task.id);
    if (this.hasActiveRun(current)) {
      this.recordSkipped(
        current,
        scheduledFor,
        this.launching.has(current.id) ? 'previous_run_starting' : 'previous_run_active'
      );
      return;
    }
    this.launching.add(current.id);
    const historyRunId = randomUUID();
    const sessionId = randomUUID();
    const processId = `scheduled-task:${current.id}:${historyRunId}`;
    const startedAt = this.now();
    try {
      const workspaceDir = await this.resolveWorkspaceDir(current, sessionId);
      this.patchTask(current.id, {
        runningSessionId: sessionId,
        runningProcessId: processId,
        lastRunAt: startedAt,
        nextRunAt: current.schedule.kind === 'manual' ? null : nextScheduledTaskRun(current.schedule, startedAt),
      });
      await this.processManager.start(processId, {
        workspaceDir,
        sessionId,
        ...(current.projectId ? { projectId: current.projectId } : {}),
        ...(current.profileName ? { profileNameOverride: current.profileName } : {}),
      });
      const wsUrl = await this.waitForWsUrl(processId);
      const watcher = await startRun(
        wsUrl,
        current.instructions,
        sessionId,
        {
          workspace_root: workspaceDir,
          cwd: workspaceDir,
          scheduled_task_id: current.id,
          scheduled_task_name: current.name,
          scheduled_task_reason: reason,
        },
        {
          onRunEnd: (result) => {
            void this.finishRun(current.id, historyRunId, processId, runEndStatus(result.reason), result.reason);
          },
          onApprovalRequested: (approval) => {
            this.updateRunStatus(current.id, historyRunId, 'waiting_for_approval', approval);
          },
          onApprovalResolved: () => {
            this.updateRunStatus(current.id, historyRunId, 'running');
          },
          onDisconnect: (message) => {
            void this.finishRun(current.id, historyRunId, processId, 'failed', message);
          },
        },
        buildStartRunOptions(current)
      );
      this.patchTask(current.id, {
        runningSessionId: watcher.sessionId ?? sessionId,
        runningProcessId: processId,
        history: this.prependHistory(this.getTask(current.id), {
          id: historyRunId,
          scheduledFor,
          startedAt,
          status: 'running',
          ...(watcher.runId ? { runId: watcher.runId } : {}),
          sessionId: watcher.sessionId ?? sessionId,
          processId,
        }),
      });
      this.notifyRun(current.name, 'running');
    } catch (error) {
      await this.stopRunProcess(processId);
      const message = (error as Error).message;
      this.patchTask(current.id, {
        runningSessionId: undefined,
        runningProcessId: undefined,
        history: this.prependHistory(this.getTask(current.id), {
          id: historyRunId,
          scheduledFor,
          startedAt,
          completedAt: this.now(),
          status: 'failed',
          sessionId,
          processId,
          reason: message,
        }),
      });
      this.notifyRun(current.name, 'failed', message);
    } finally {
      this.launching.delete(current.id);
    }
  }

  private hasActiveRun(task: ScheduledTask): boolean {
    return this.launching.has(task.id) || Boolean(task.runningProcessId || task.runningSessionId);
  }

  private async finishRun(
    taskId: string,
    historyRunId: string,
    processId: string,
    status: 'completed' | 'failed',
    reason?: string
  ): Promise<void> {
    if (this.completing.has(historyRunId)) {
      return;
    }
    this.completing.add(historyRunId);
    try {
      await this.stopRunProcess(processId);
      const task = this.tasks().find((item) => item.id === taskId);
      if (!task) {
        return;
      }
      const history = (task.history ?? []).map((run) =>
        run.id === historyRunId
          ? {
              ...run,
              completedAt: this.now(),
              status,
              pendingApprovalToolName: undefined,
              pendingApprovalServerLabel: undefined,
              pendingApprovalKind: undefined,
              ...(reason ? { reason } : {}),
            }
          : run
      );
      this.patchTask(taskId, {
        ...(task.runningProcessId === processId ? { runningSessionId: undefined, runningProcessId: undefined } : {}),
        history,
      });
      this.notifyRun(task.name, status, reason);
    } finally {
      this.completing.delete(historyRunId);
    }
  }

  private updateRunStatus(
    taskId: string,
    historyRunId: string,
    status: ScheduledTaskRun['status'],
    approval?: ApprovalRequest
  ): void {
    const task = this.tasks().find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    let changed = false;
    const history = (task.history ?? []).map((run) => {
      if (run.id !== historyRunId || (run.status !== 'running' && run.status !== 'waiting_for_approval')) {
        return run;
      }
      if (run.status === status && !approval) {
        return run;
      }
      changed = true;
      if (status === 'waiting_for_approval') {
        return {
          ...run,
          status,
          ...(approval?.toolName ? { pendingApprovalToolName: approval.toolName } : {}),
          ...(approval?.serverLabel ? { pendingApprovalServerLabel: approval.serverLabel } : {}),
          ...(approval?.kind ? { pendingApprovalKind: approval.kind } : {}),
        };
      }
      return {
        ...run,
        status,
        pendingApprovalToolName: undefined,
        pendingApprovalServerLabel: undefined,
        pendingApprovalKind: undefined,
      };
    });
    if (!changed) {
      return;
    }
    this.patchTask(taskId, { history });
    if (status === 'waiting_for_approval') {
      this.notifyRun(task.name, status);
    }
  }

  private notifyRun(taskName: string, status: NotifiableRunStatus, reason?: string): void {
    this.sendToWindow?.('toast:show', buildRunToast(taskName, status, reason));
  }

  private async stopRunProcess(processId: string): Promise<void> {
    try {
      await this.processManager.stop(processId);
    } catch {}
  }

  private async waitForWsUrl(processId: string): Promise<string> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = this.processManager.getStatus(processId);
      if ((status.type === 'running' || status.type === 'connecting') && status.data.wsUrl) {
        return status.data.wsUrl;
      }
      if (status.type === 'error') {
        throw new Error(status.error.message);
      }
      await delay(500);
    }
    throw new Error('Timed out waiting for scheduled task agent process');
  }

  private async resolveWorkspaceDir(task: ScheduledTask, sessionId: string): Promise<string> {
    const baseDir = this.store.get('workspaceDir');
    if (task.projectId) {
      const project = this.getProjects().find((item) => item.id === task.projectId);
      const projectWorkspaceDir = getLocalWorkspaceDir(firstSource(project));
      if (projectWorkspaceDir) {
        return projectWorkspaceDir;
      }
      if (!baseDir?.trim()) {
        throw new Error('Workspace root is not configured');
      }
      return join(baseDir, 'Projects', project?.slug ?? task.projectId);
    }
    if (!baseDir?.trim()) {
      throw new Error('Workspace root is not configured');
    }
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    const dir = join(baseDir, 'Sessions', safeId);
    await ensureDirectory(dir);
    return dir;
  }

  private recomputeNextRuns(): void {
    const now = this.now();
    let changed = false;
    const tasks = this.tasks().map((task) => {
      if (!task.enabled || task.nextRunAt !== undefined) {
        return task;
      }
      changed = true;
      return { ...task, nextRunAt: nextScheduledTaskRun(task.schedule, now) };
    });
    if (changed) {
      this.writeTasks(tasks);
    }
  }

  private recordSkipped(task: ScheduledTask, scheduledFor: number, reason: string): void {
    const current = this.getTask(task.id);
    this.patchTask(task.id, {
      nextRunAt: task.schedule.kind === 'manual' ? null : nextScheduledTaskRun(task.schedule, this.now()),
      history: this.prependHistory(current, {
        id: randomUUID(),
        scheduledFor,
        startedAt: this.now(),
        status: 'skipped',
        reason,
      }),
    });
  }

  private prependHistory(task: ScheduledTask, run: ScheduledTaskRun): ScheduledTaskRun[] {
    return [run, ...(task.history ?? [])].slice(0, HISTORY_LIMIT);
  }

  private getTask(taskId: string): ScheduledTask {
    const task = this.tasks().find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    return task;
  }

  private patchTask(taskId: string, patch: Partial<ScheduledTask>): void {
    const tasks = this.tasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) {
      return;
    }
    const prior = tasks[index];
    if (!prior) {
      return;
    }
    const next: ScheduledTask = { ...prior, ...patch, updatedAt: this.now() };
    const updated = [...tasks];
    updated[index] = next;
    this.writeTasks(updated);
  }

  private tasks(): ScheduledTask[] {
    return (this.store.get('scheduledTasks') ?? []).map(normalizeScheduledTask);
  }

  private writeTasks(tasks: ScheduledTask[]): void {
    this.store.set('scheduledTasks', tasks);
    this.sendToWindow?.('store:changed', (this.store as Store<StoreData>).store as StoreData | undefined);
  }
}

export function registerScheduledTaskHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => ScheduledTaskManager
): string[] {
  ipc.handle('scheduled-task:list', (event: unknown) => resolve(event).list());
  ipc.handle('scheduled-task:create', (event: unknown, input: ScheduledTaskInput) => resolve(event).create(input));
  ipc.handle('scheduled-task:update', (event: unknown, taskId: string, patch: ScheduledTaskUpdate) =>
    resolve(event).update(taskId, patch)
  );
  ipc.handle('scheduled-task:delete', (event: unknown, taskId: string) => resolve(event).delete(taskId));
  ipc.handle('scheduled-task:run-now', (event: unknown, taskId: string) => resolve(event).runNow(taskId));
  ipc.handle('scheduled-task:allow-tool', (event: unknown, taskId: string, toolName: string) =>
    resolve(event).allowTool(taskId, toolName)
  );
  ipc.handle('scheduled-task:revoke-tool', (event: unknown, taskId: string, toolName: string) =>
    resolve(event).revokeTool(taskId, toolName)
  );
  ipc.handle('scheduled-task:allow-mcp-tool', (event: unknown, taskId: string, tool: ScheduledTaskAllowedMcpTool) =>
    resolve(event).allowMcpTool(taskId, tool)
  );
  ipc.handle('scheduled-task:revoke-mcp-tool', (event: unknown, taskId: string, tool: ScheduledTaskAllowedMcpTool) =>
    resolve(event).revokeMcpTool(taskId, tool)
  );
  return [
    'scheduled-task:list',
    'scheduled-task:create',
    'scheduled-task:update',
    'scheduled-task:delete',
    'scheduled-task:run-now',
    'scheduled-task:allow-tool',
    'scheduled-task:revoke-tool',
    'scheduled-task:allow-mcp-tool',
    'scheduled-task:revoke-mcp-tool',
  ];
}

async function startRun(
  wsUrl: string,
  prompt: string,
  sessionId: string,
  variables: Record<string, unknown>,
  handlers: {
    onRunEnd: (result: RunEndResult) => void;
    onApprovalRequested: (approval: ApprovalRequest) => void;
    onApprovalResolved: () => void;
    onDisconnect: (message: string) => void;
  },
  options?: StartRunOptions
): Promise<StartRunWatcher> {
  return new Promise((resolve, reject) => {
    const socket = new WsWebSocket(wsUrl);
    const id = randomUUID();
    let resolved = false;
    let finished = false;
    let closedByManager = false;
    let runId: string | undefined;
    let resolvedSessionId: string | undefined = sessionId;
    const timer = setTimeout(() => {
      closedByManager = true;
      socket.close();
      reject(new Error('start_run timed out'));
    }, RPC_TIMEOUT_MS);
    const close = (): void => {
      closedByManager = true;
      socket.close();
    };
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'start_run',
          params: {
            prompt,
            session_id: sessionId,
            variables,
            ...(options?.safeToolOverrides ? { safe_tool_overrides: options.safeToolOverrides } : {}),
          },
        })
      );
    });
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id === id) {
          clearTimeout(timer);
          if (msg.error) {
            closedByManager = true;
            socket.close();
            reject(new Error(msg.error.message ?? 'start_run failed'));
            return;
          }
          const result = parseStartRunResult(msg.result, sessionId);
          runId = result.runId;
          resolvedSessionId = result.sessionId;
          resolved = true;
          resolve({ ...result, close });
          return;
        }
        if (msg.method === 'tool_approval_requested' || msg.method === 'mcp_approval_requested') {
          const result = parseRunEventIdentity(msg.params);
          if (!hasRunIdentity(result) || matchesRun(result, runId, resolvedSessionId)) {
            handlers.onApprovalRequested(parseApprovalRequest(msg.method, msg.params));
          }
          return;
        }
        if (msg.method === 'tool_approval_resolved' || msg.method === 'mcp_approval_resolved') {
          const result = parseRunEventIdentity(msg.params);
          if (!hasRunIdentity(result) || matchesRun(result, runId, resolvedSessionId)) {
            handlers.onApprovalResolved();
          }
          return;
        }
        if (msg.method !== 'run_end') {
          return;
        }
        const result = parseRunEndResult(msg.params);
        if (!matchesRun(result, runId, resolvedSessionId)) {
          return;
        }
        finished = true;
        close();
        handlers.onRunEnd(result);
      } catch (error) {
        if (!resolved) {
          clearTimeout(timer);
          closedByManager = true;
          socket.close();
          reject(error);
        }
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (resolved) {
        if (!finished && !closedByManager) {
          finished = true;
          handlers.onDisconnect(error.message);
        }
      } else {
        reject(error);
      }
    });
    socket.once('close', () => {
      clearTimeout(timer);
      if (resolved && !finished && !closedByManager) {
        finished = true;
        handlers.onDisconnect('scheduled task run connection closed before run_end');
      } else if (!resolved && !closedByManager) {
        reject(new Error('start_run connection closed'));
      }
    });
  });
}

function parseStartRunResult(result: unknown, fallbackSessionId: string): StartRunResult {
  const data = isRecord(result) ? result : {};
  return {
    ...(typeof data.run_id === 'string' && data.run_id ? { runId: data.run_id } : {}),
    sessionId: typeof data.session_id === 'string' && data.session_id ? data.session_id : fallbackSessionId,
  };
}

function parseRunEndResult(params: unknown): RunEndResult {
  const data = isRecord(params) ? params : {};
  return {
    ...(typeof data.run_id === 'string' && data.run_id ? { runId: data.run_id } : {}),
    ...(typeof data.session_id === 'string' && data.session_id ? { sessionId: data.session_id } : {}),
    ...(typeof data.end_reason === 'string' && data.end_reason ? { reason: data.end_reason } : {}),
  };
}

function parseRunEventIdentity(params: unknown): RunEndResult {
  const data = isRecord(params) ? params : {};
  return {
    ...(typeof data.run_id === 'string' && data.run_id ? { runId: data.run_id } : {}),
    ...(typeof data.session_id === 'string' && data.session_id ? { sessionId: data.session_id } : {}),
  };
}

function parseApprovalRequest(method: string, params: unknown): ApprovalRequest {
  const data = isRecord(params) ? params : {};
  const toolName = typeof data.tool_name === 'string' && data.tool_name.trim() ? data.tool_name.trim() : undefined;
  const serverLabel =
    typeof data.server_label === 'string' && data.server_label.trim() ? data.server_label.trim() : undefined;
  return {
    kind: method === 'mcp_approval_requested' ? 'mcp' : 'function',
    ...(toolName ? { toolName } : {}),
    ...(serverLabel ? { serverLabel } : {}),
  };
}

function hasRunIdentity(result: RunEndResult): boolean {
  return Boolean(result.runId || result.sessionId);
}

function matchesRun(result: RunEndResult, runId: string | undefined, sessionId: string | undefined): boolean {
  if (result.runId && runId) {
    return result.runId === runId;
  }
  if (result.sessionId && sessionId) {
    return result.sessionId === sessionId;
  }
  return false;
}

function runEndStatus(reason: string | undefined): 'completed' | 'failed' {
  return reason && ['failed', 'error', 'cancelled', 'canceled'].includes(reason) ? 'failed' : 'completed';
}

function buildRunToast(
  taskName: string,
  status: NotifiableRunStatus,
  reason?: string
): IpcRendererEvents['toast:show'][0] {
  if (status === 'waiting_for_approval') {
    return {
      level: 'warning',
      title: `Routine needs approval: ${taskName}`,
      description: 'Open the routine session to review the request.',
    };
  }
  if (status === 'completed') {
    return {
      level: 'success',
      title: `Routine completed: ${taskName}`,
      ...(reason && reason !== 'completed' ? { description: reason } : {}),
    };
  }
  if (status === 'failed') {
    return {
      level: 'error',
      title: `Routine failed: ${taskName}`,
      description: reason ?? 'The run ended with an error.',
    };
  }
  return {
    level: 'info',
    title: `Routine started: ${taskName}`,
    description: 'Run is in progress.',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateTask(task: ScheduledTask): void {
  if (!task.name.trim()) {
    throw new Error('Name is required');
  }
  if (!task.instructions.trim()) {
    throw new Error('Instructions are required');
  }
  if (task.permissionMode !== 'ask') {
    throw new Error('Unsupported permission mode');
  }
  if (!Array.isArray(task.allowedToolNames) || task.allowedToolNames.some((toolName) => !normalizeToolName(toolName))) {
    throw new Error('Allowed tool names must be non-empty strings');
  }
  normalizeMcpTools(task.allowedMcpTools);
}

function normalizeScheduledTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    permissionMode: task.permissionMode ?? DEFAULT_PERMISSION_MODE,
    allowedToolNames: normalizeToolNames(task.allowedToolNames),
    allowedMcpTools: normalizeMcpTools(task.allowedMcpTools),
  };
}

function buildStartRunOptions(task: ScheduledTask): StartRunOptions | undefined {
  const allowedToolNames = normalizeToolNames(task.allowedToolNames);
  const allowedMcpTools = normalizeMcpTools(task.allowedMcpTools);
  const safeToolOverrides: SafeToolOverrides = {
    ...(allowedToolNames.length > 0 ? { safe_tool_names: allowedToolNames } : {}),
    ...(allowedMcpTools.length > 0
      ? {
          safe_mcp_tools: allowedMcpTools.map((tool) => ({
            server_label: tool.serverLabel,
            tool_name: tool.toolName,
          })),
        }
      : {}),
  };
  if (safeToolOverrides.safe_tool_names || safeToolOverrides.safe_mcp_tools) {
    return { safeToolOverrides };
  }
  return undefined;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (!normalized) {
    throw new Error('Tool name is required');
  }
  return normalized;
}

function normalizeToolNames(toolNames: unknown): string[] {
  if (!Array.isArray(toolNames)) {
    return [];
  }
  return [
    ...new Set(
      toolNames
        .filter((toolName): toolName is string => typeof toolName === 'string')
        .map((toolName) => toolName.trim())
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function normalizeMcpTool(tool: ScheduledTaskAllowedMcpTool): ScheduledTaskAllowedMcpTool {
  const serverLabel = typeof tool.serverLabel === 'string' ? tool.serverLabel.trim() : '';
  const toolName = typeof tool.toolName === 'string' ? tool.toolName.trim() : '';
  if (!serverLabel) {
    throw new Error('MCP server label is required');
  }
  if (!toolName) {
    throw new Error('MCP tool name is required');
  }
  return { serverLabel, toolName };
}

function normalizeMcpTools(tools: unknown): ScheduledTaskAllowedMcpTool[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const normalized: ScheduledTaskAllowedMcpTool[] = [];
  for (const item of tools) {
    if (!isRecord(item)) {
      continue;
    }
    const serverLabel = typeof item.serverLabel === 'string' ? item.serverLabel.trim() : '';
    const toolName = typeof item.toolName === 'string' ? item.toolName.trim() : '';
    if (!serverLabel || !toolName || normalized.some((tool) => sameMcpTool(tool, { serverLabel, toolName }))) {
      continue;
    }
    normalized.push({ serverLabel, toolName });
  }
  return normalized.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel) || a.toolName.localeCompare(b.toolName));
}

function sameMcpTool(left: ScheduledTaskAllowedMcpTool, right: ScheduledTaskAllowedMcpTool): boolean {
  return left.serverLabel === right.serverLabel && left.toolName === right.toolName;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
