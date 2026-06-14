/**
 * Interfaces for ProjectManager's external dependencies.
 *
 * These allow ProjectManager's orchestration logic to be tested with stubs
 * instead of requiring real WebSocket servers or file systems.
 */

import type { SupervisorBridge } from '@/main/supervisor-bridge';
import type { IpcRendererEvents, StoreData } from '@/shared/types';

// ---------------------------------------------------------------------------
// IWindowSender — sends IPC events to the renderer
// ---------------------------------------------------------------------------

export type IWindowSender = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

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
  bridge: SupervisorBridge;
};
