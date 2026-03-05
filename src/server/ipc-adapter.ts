type HandleFn = (channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;

/**
 * Adapts a handler registration function to look like Electron's IpcListener.handle() API.
 * The managers call `ipc.handle(channel, (event, ...args) => result)` where
 * `event` is the Electron IpcMainInvokeEvent. We pass `null` as the event placeholder.
 *
 * Can target either global handlers (for shared handlers like store/util)
 * or per-session handlers (for client-scoped handlers like terminal/sandbox).
 */
export class ServerIpcAdapter {
  constructor(private handleFn: HandleFn) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: null, ...args: any[]) => any): void {
    this.handleFn(channel, (...args: unknown[]) => {
      return handler(null, ...args);
    });
  }
}
