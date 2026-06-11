/**
 * Main-process side of the cloud reverse-RPC bridge.
 *
 * In cloud-linked Electron the WS lives in the renderer (it would be a much
 * bigger refactor to move it). But compute lifecycle (start/stop/snapshot
 * containers, exec into local omni-serve, ...) all lives in main. So we
 * route reverse-RPCs through a thin renderer↔main IPC bridge:
 *
 *   1. Cloud sends `{type: 'reverse-invoke', id, channel, args}` over the WS.
 *   2. Renderer's `WsTransportEmitter` reaches into its reverse-handler map,
 *      finds the channel registered as a "main-forward" handler, and calls
 *      `localEmitter.invoke('reverse-rpc:dispatch', channel, args)`.
 *   3. Main's `reverseRpcRouter` looks up the channel in `mainHandlers`,
 *      awaits the result, and returns it.
 *   4. Renderer ships the result back as `reverse-response`.
 *
 * This module owns step 3 — the per-channel handler registry that main
 * components (compute, tunnel, identity) populate at boot.
 */
import { ipcMain } from 'electron';

import type { IIpcListener } from '@/shared/ipc-listener';

export type MainReverseHandler = (...args: unknown[]) => unknown | Promise<unknown>;

const handlers = new Map<string, MainReverseHandler>();

/**
 * Register a main-side reverse handler. Re-registration replaces the
 * previous handler for the channel (last-write-wins; useful when the
 * compute-client setup runs again after a settings change).
 */
export const registerMainReverseHandler = (
  channel: string,
  handler: MainReverseHandler
): (() => void) => {
  handlers.set(channel, handler);
  return () => {
    const current = handlers.get(channel);
    if (current === handler) {
      handlers.delete(channel);
    }
  };
};

/**
 * Wire the single `reverse-rpc:dispatch` IPC channel main listens on. Call
 * once at boot from `src/main/index.ts`.
 */
export const wireReverseRpcRouter = (ipc: IIpcListener): (() => void) => {
  ipc.handle('reverse-rpc:dispatch', async (_event, channel: unknown, args: unknown) => {
    const ch = String(channel);
    const handler = handlers.get(ch);
    if (!handler) {
      throw new Error(`No main-side reverse handler for channel: ${ch}`);
    }
    const rest = Array.isArray(args) ? args : [];
    return handler(...rest);
  });
  return () => {
    ipcMain.removeHandler('reverse-rpc:dispatch');
  };
};

/** Visible to tests so they can flush the registry between cases. */
export const __clearReverseHandlersForTests = (): void => {
  handlers.clear();
};

/** Visible to tests so they can drive handlers without an Electron IPC bus. */
export const __getHandlersForTests = (): Map<string, MainReverseHandler> => handlers;
