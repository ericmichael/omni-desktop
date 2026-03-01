import { IpcEmitter, IpcListener } from '@electron-toolkit/typed-ipc/renderer';

import type { TransportEmitter, TransportListener } from '@/shared/transport';
import type { IpcEvents, IpcRendererEvents } from '@/shared/types';

/**
 * Electron IPC adapter that conforms to the TransportEmitter interface.
 * Delegates directly to IpcEmitter — zero overhead.
 */
export class ElectronTransportEmitter implements TransportEmitter {
  private emitter = new IpcEmitter<IpcEvents>();

  invoke<E extends keyof IpcEvents>(channel: E, ...args: Parameters<IpcEvents[E]>): Promise<ReturnType<IpcEvents[E]>> {
    return this.emitter.invoke(channel as Extract<E, string>, ...args);
  }
}

/**
 * Electron IPC adapter that conforms to the TransportListener interface.
 * Strips the Electron.IpcRendererEvent first arg from on() callbacks so consumers
 * receive only the actual event data.
 */
export class ElectronTransportListener implements TransportListener {
  private listener = new IpcListener<IpcRendererEvents>();

  on<E extends keyof IpcRendererEvents>(channel: E, callback: (...args: IpcRendererEvents[E]) => void): () => void {
    return this.listener.on(channel as Extract<E, string>, (_event, ...args) => {
      callback(...args);
    });
  }
}
