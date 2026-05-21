import type { HandlerContext } from '@/server/ws-handler';
import type { IIpcListener } from '@/shared/ipc-listener';

type CtxHandleFn = (
  channel: string,
  handler: (ctx: HandlerContext, ...args: unknown[]) => unknown | Promise<unknown>
) => void;

/**
 * Adapts a ctx-aware handler registration function to look like Electron's
 * IpcListener.handle() API. The managers call `ipc.handle(channel, (event,
 * ...args) => result)` where `event` is the Electron IpcMainInvokeEvent. In
 * server mode we pass the per-invoke {@link HandlerContext} in that slot, so a
 * handler that wants the authenticated tenant reads `event.tenantId`, while
 * handlers that ignore the event (`_`) behave exactly as before.
 *
 * Can target either global handlers (via `WsHandler.handleCtx`, for shared
 * handlers like store/util) or per-session handlers (via the onConnect
 * `handle`, for client-scoped handlers like terminal/sandbox).
 */
export class ServerIpcAdapter implements IIpcListener {
  constructor(private handleFn: CtxHandleFn) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: any, ...args: any[]) => any): void {
    this.handleFn(channel, (ctx: HandlerContext, ...args: unknown[]) => {
      return handler(ctx, ...args);
    });
  }
}
