import type { IpcEvents, IpcRendererEvents } from '@/shared/types';

/**
 * Transport interface for invoking IPC events (renderer → main).
 * Mirrors what IpcEmitter provides in Electron.
 */
export interface TransportEmitter {
  invoke<E extends keyof IpcEvents>(channel: E, ...args: Parameters<IpcEvents[E]>): Promise<ReturnType<IpcEvents[E]>>;
}

/**
 * Transport interface for listening to IPC events (main → renderer).
 * Unlike Electron's IpcListener, callbacks receive only the event args (no Electron.IpcRendererEvent first arg).
 */
export interface TransportListener {
  on<E extends keyof IpcRendererEvents>(channel: E, listener: (...args: IpcRendererEvents[E]) => void): () => void;
}
