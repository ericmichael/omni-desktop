/**
 * Interfaces for ProjectManager's external dependencies.
 *
 * These allow ProjectManager's orchestration logic to be tested with stubs
 * instead of requiring real WebSocket servers or file systems.
 */

import type { WorkflowConfig } from '@/lib/workflow';
import type { SupervisorBridge } from '@/main/supervisor-bridge';
import type { IpcRendererEvents, StoreData } from '@/shared/types';

// ---------------------------------------------------------------------------
// IWorkflowLoader — FLEET.md configuration
// ---------------------------------------------------------------------------

export { type WorkflowConfig } from '@/lib/workflow';

export interface IWorkflowLoader {
  load(projectId: string, workspaceDir: string): Promise<unknown>;
  loadFromRemote(projectId: string, repoUrl: string, branch?: string): Promise<unknown>;
  get(projectId: string): unknown | null;
  getConfig(projectId: string): WorkflowConfig;
  getPromptTemplate(projectId: string): string;
  runHook(projectId: string, hookName: string, workspaceDir: string): Promise<boolean>;
  dispose(): void;
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
  bridge: SupervisorBridge;
};
