/**
 * Renderer-side bridge for laptop → cloud tunnel frames (Phase 3).
 *
 * Main owns the inner-WS to local omni-serve; when it receives a frame back,
 * it pushes a `tunnel:emit-incoming` IPC event with the cloud's tunnelId. This
 * shim listens for that event and invokes `tunnel:incoming` on the cloud WS,
 * where `local-tunnel-proxy.ts` routes it to the awaiting client socket.
 *
 * No-op outside cloud-linked Electron — the cloud is the only consumer of
 * `tunnel:incoming` invokes, and main only emits when the tunnel handlers are
 * registered (cloud-link is the trigger).
 */
import { emitter, isCloudLinked, isElectron } from '@/renderer/services/ipc';
import { ElectronTransportListener } from '@/renderer/transport/electron-transport';

let initialized = false;

export const initTunnelBridge = (): void => {
  if (initialized) return;
  initialized = true;
  if (!isElectron || !isCloudLinked) return;
  // `tunnel:emit-incoming` is pushed by LOCAL Electron main (`sendToWindow`), so
  // it arrives over Electron IPC — NOT the cloud WS. In cloud-linked mode the
  // shared `ipc` listener IS the cloud WS, which never sees these frames (that
  // bug silently dropped every laptop→cloud tunnel reply, so the host_bridge
  // `create` op hung forever). Listen on a dedicated local Electron IPC
  // listener, then forward to the cloud via `emitter`.
  const localIpc = new ElectronTransportListener();
  localIpc.on('tunnel:emit-incoming', (event) => {
    // Fire-and-forget — the cloud doesn't gate on our ack and a hung response
    // shouldn't block subsequent frames. A missing tunnel routing entry is
    // dropped silently by the cloud's listener (see local-tunnel-proxy.ts).
    void emitter.invoke('tunnel:incoming', event).catch((err) => {
      console.error('[tunnel-bridge] forward failed:', err);
    });
  });
};
