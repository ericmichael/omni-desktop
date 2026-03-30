/**
 * Interfaces for ProjectManager's external dependencies.
 *
 * These allow ProjectManager's orchestration logic to be tested with stubs
 * instead of requiring real Docker containers, WebSocket servers, and file systems.
 */

import type { TicketPhase } from '@/shared/ticket-phase';
import type { WorkflowConfig } from '@/lib/workflow';
import type {
  SessionMessage,
  TicketId,
  TokenUsage,
  IpcRendererEvents,
  StoreData,
  WithTimestamp,
  SandboxProcessStatus,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// ITicketMachine — the state machine for a single ticket's supervisor
// ---------------------------------------------------------------------------

export interface ITicketMachine {
  getPhase(): TicketPhase;
  isActive(): boolean;
  isStreaming(): boolean;
  getSessionId(): string | null;

  transition(to: TicketPhase): void;
  forcePhase(phase: TicketPhase): void;

  setWsUrl(url: string): void;
  createSession(variables?: Record<string, unknown>): Promise<string>;
  startRun(
    prompt: string,
    opts?: { sessionId?: string; variables?: Record<string, unknown> }
  ): Promise<{ sessionId: string }>;
  stop(): Promise<void>;
  dispose(): void;

  recordActivity(): void;
  cancelRetryTimer(): void;
  scheduleRetryTimer(delayMs: number, callback: () => void): void;

  continuationTurn: number;
  retryAttempt: number;
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// ISandbox — a sandbox container
// ---------------------------------------------------------------------------

export interface ISandbox {
  start(opts: { workspaceDir: string; sandboxVariant: string }): void;
  stop(): Promise<void>;
  getStatus(): WithTimestamp<SandboxProcessStatus> | null;
}

// ---------------------------------------------------------------------------
// ISandboxFactory — creates sandboxes (allows test stubs)
// ---------------------------------------------------------------------------

export interface ISandboxFactory {
  create(opts: {
    onStatusChange: (status: WithTimestamp<SandboxProcessStatus>) => void;
  }): ISandbox;
}

// ---------------------------------------------------------------------------
// IWorkflowLoader — FLEET.md configuration
// ---------------------------------------------------------------------------

export { type WorkflowConfig } from '@/lib/workflow';

export interface IWorkflowLoader {
  load(projectId: string, workspaceDir: string): Promise<unknown>;
  get(projectId: string): unknown | null;
  getConfig(projectId: string): WorkflowConfig;
  getPromptTemplate(projectId: string): string;
  runHook(projectId: string, hookName: string, workspaceDir: string): Promise<boolean>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// IMachineFactory — creates ticket machines (allows test stubs)
// ---------------------------------------------------------------------------

export type MachineCallbacks = {
  onPhaseChange: (ticketId: TicketId, phase: TicketPhase) => void;
  onMessage: (ticketId: TicketId, msg: SessionMessage) => void;
  onRunEnd: (ticketId: TicketId, reason: string) => void;
  onTokenUsage: (ticketId: TicketId, usage: TokenUsage) => void;
  onClientRequest?: (
    ticketId: TicketId,
    functionName: string,
    args: Record<string, unknown>,
    respond: (ok: boolean, result?: Record<string, unknown>) => void
  ) => void;
};

export interface IMachineFactory {
  create(ticketId: TicketId, callbacks: MachineCallbacks): ITicketMachine;
}

// ---------------------------------------------------------------------------
// IWindowSender — sends IPC events to the renderer
// ---------------------------------------------------------------------------

export type IWindowSender = <T extends keyof IpcRendererEvents>(
  channel: T,
  ...args: IpcRendererEvents[T]
) => void;

// ---------------------------------------------------------------------------
// IStore — ticket/project store abstraction
// ---------------------------------------------------------------------------

export interface IStore {
  get<K extends keyof StoreData>(key: K, defaultValue: StoreData[K]): StoreData[K];
  set<K extends keyof StoreData>(key: K, value: StoreData[K]): void;
  readonly store: StoreData;
}

// ---------------------------------------------------------------------------
// Combined deps object for ProjectManager constructor
// ---------------------------------------------------------------------------

export type ProjectManagerDeps = {
  store: IStore;
  sendToWindow: IWindowSender;
  workflowLoader: IWorkflowLoader;
  sandboxFactory: ISandboxFactory;
  machineFactory: IMachineFactory;
};
