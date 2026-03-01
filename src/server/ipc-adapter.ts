import type { WsHandler } from '@/server/ws-handler';

/**
 * Adapts WsHandler to look like Electron's IpcListener.handle() API.
 * The managers call `ipc.handle(channel, (event, ...args) => result)` where
 * `event` is the Electron IpcMainInvokeEvent. We pass `null` as the event placeholder.
 */
export class ServerIpcAdapter {
  constructor(private wsHandler: WsHandler) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: null, ...args: any[]) => any): void {
    this.wsHandler.handle(channel, (...args: unknown[]) => {
      return handler(null, ...args);
    });
  }
}
