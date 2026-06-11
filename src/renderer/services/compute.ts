/**
 * Renderer-side shim that hooks cloud reverse-invoke frames and forwards
 * each compute-* call into local Electron main.
 *
 * The cloud only knows how to talk to the renderer's WS, but compute lives
 * in main (`ProcessManager`, snapshot/tunnel handlers, etc.). For each
 * channel in {@link FORWARDED_CHANNELS} we register a reverse handler on
 * the WS that calls `localEmitter.invoke('reverse-rpc:dispatch', channel,
 * args)` and returns whatever main returns — making it look as though main
 * were the direct cloud peer.
 *
 * `init()` is idempotent and safe to call from boot regardless of mode; it
 * is a no-op outside cloud-linked Electron because (a) no `wsEmitter`
 * exists in standalone Electron, and (b) the browser/server build doesn't
 * forward to a non-existent main process.
 */
import { isCloudLinked, isElectron, localEmitter, wsEmitter } from '@/renderer/services/ipc';

/**
 * Channels the cloud may reverse-invoke on the laptop. Keep this list in
 * sync with what `main/compute-reverse-handlers.ts` actually implements —
 * forwarding an unknown channel surfaces as a "No main-side reverse
 * handler" error to the cloud, which is the right failure mode but also
 * never useful in practice.
 */
const FORWARDED_CHANNELS = [
  // Computer-as-sandbox: the agent stays in the cloud; we only stand up an
  // `omni sandbox-host` exec server (the sandbox backend) on this machine.
  'compute:ensure-host',
  'compute:stop-host',
  // Tunnel relay carrying the host_bridge exec channel + exposed-port traffic
  // from the cloud to this machine's loopback ports (see local-tunnel-proxy.ts
  // and tunnel-handler.ts).
  'compute:tunnel-http',
  'compute:tunnel-ws-open',
  'compute:tunnel-ws-write',
  'compute:tunnel-ws-close',
] as const;

let initialized = false;

export const initComputeBridge = (): void => {
  if (initialized) return;
  initialized = true;
  if (!isElectron || !isCloudLinked || !wsEmitter) {
    return;
  }
  for (const channel of FORWARDED_CHANNELS) {
    wsEmitter.addReverseHandler(channel, async (...args: unknown[]) => {
      // `localEmitter.invoke` is typed against IpcEvents — this channel is
      // declared in `ReverseRpcIpcEvents` (`reverse-rpc:dispatch`).
      return localEmitter.invoke('reverse-rpc:dispatch', channel, args);
    });
  }
};
