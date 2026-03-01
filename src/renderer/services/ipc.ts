import { ElectronTransportEmitter, ElectronTransportListener } from '@/renderer/transport/electron-transport';
import { WsTransportEmitter, WsTransportListener } from '@/renderer/transport/ws-transport';
import type { TransportEmitter, TransportListener } from '@/shared/transport';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

const createTransport = (): { emitter: TransportEmitter; ipc: TransportListener } => {
  if (isElectron) {
    return {
      emitter: new ElectronTransportEmitter(),
      ipc: new ElectronTransportListener(),
    };
  }

  const wsEmitter = new WsTransportEmitter();
  return {
    emitter: wsEmitter,
    ipc: new WsTransportListener(wsEmitter),
  };
};

const transport = createTransport();

/**
 * A typed transport listener for the renderer process.
 * In Electron: backed by IPC. In browser: backed by WebSocket.
 */
export const ipc: TransportListener = transport.ipc;

/**
 * A typed transport emitter for the renderer process.
 * In Electron: backed by IPC. In browser: backed by WebSocket.
 */
export const emitter: TransportEmitter = transport.emitter;
