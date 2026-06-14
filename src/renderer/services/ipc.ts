import { ElectronTransportEmitter, ElectronTransportListener } from '@/renderer/transport/electron-transport';
import { WsTransportEmitter, WsTransportListener } from '@/renderer/transport/ws-transport';
import type { TransportEmitter, TransportListener } from '@/shared/transport';
import type { CloudMode } from '@/shared/types';

/**
 * True in the Electron desktop app, false in the browser/server build. Drives
 * hiding controls that are no-ops in hosted mode (host-filesystem pickers, the
 * runtime installer, the in-PATH CLI, launcher auto-update, local-file imports).
 */
export const isElectron = typeof window !== 'undefined' && 'electron' in window;

/**
 * Preload-injected bootstrap data. ``cloudMode`` is the persisted
 * ``StoreData.cloudMode``, copied into the window at BrowserWindow creation
 * (see main-process-manager.ts + preload/index.ts). Non-null means the
 * Electron app is linked to a cloud launcher and the renderer should route
 * its transport over WebSocket to that origin, Bearer-authenticated via
 * the ``cloud:get-access-token`` IPC.
 */
type OmniBootstrap = { cloudMode: CloudMode | null };
const bootstrap: OmniBootstrap = ((): OmniBootstrap => {
  const fromWindow =
    (typeof window !== 'undefined'
      ? (window as unknown as { __omniBootstrap?: OmniBootstrap }).__omniBootstrap
      : undefined) ?? null;
  return fromWindow ?? { cloudMode: null };
})();

/**
 * True when this Electron renderer is linked to a cloud launcher. The
 * transport-construction path below routes through the cloud WS instead of
 * local Electron IPC; settings UI uses this to show the "Disconnect from
 * cloud" affordance and hide local-only controls that don't apply.
 */
export const isCloudLinked = isElectron && bootstrap.cloudMode !== null;

/**
 * The origin the launcher actually lives at — the same origin that serves
 * ``/proxy/...`` reverse-proxy routes, ``/api/...`` endpoints, and the WS
 * upgrade target. Browser server-mode = same-origin (``window.location.origin``).
 * Cloud-linked Electron = the configured cloud baseUrl, because the renderer
 * is loaded from ``localhost:5173`` (dev) or ``file://`` (prod) — neither of
 * which can resolve the launcher's relative URLs.
 *
 * Use this anywhere the renderer would otherwise reach for
 * ``window.location.origin`` to talk to the launcher (iframe srcs derived
 * from ``/proxy/...`` payloads, ``fetch('/proxy/_register', …)``, WebSocket
 * base URL builders, etc.). Don't use it for renderer-local concerns
 * (intra-window navigation, asset loading from the renderer's own bundle).
 */
export const serverOrigin = (): string => bootstrap.cloudMode?.url ?? location.origin;

/** WebSocket-protocol counterpart of {@link serverOrigin}. */
export const serverWsOrigin = (): string => {
  const origin = serverOrigin();
  return origin.replace(/^http(s?):/i, 'ws$1:');
};

/**
 * Bundled transport surface returned by {@link createTransport}.
 *
 * - `emitter` is the renderer's invoke channel. In standalone Electron it is
 *   `ElectronTransportEmitter` (Electron IPC → main). In browser/server mode
 *   it is `WsTransportEmitter` (renderer → server WS). In cloud-linked
 *   Electron it routes invokes to the cloud WS — so it must NOT be used for
 *   channels handled only in local main (cloud-link flow, machine identity,
 *   shell dialogs, etc.); those use {@link localEmitter} instead.
 * - `localEmitter` is Electron IPC → local main. In cloud-linked Electron it
 *   is a separate `ElectronTransportEmitter`; in every other mode it equals
 *   `emitter`. Callers don't need to branch — they pick the right emitter
 *   based on which side handles the channel.
 * - `ipc` listens for server-pushed events (main → renderer / cloud → renderer).
 * - `wsEmitter` is the underlying WsTransportEmitter when the active
 *   transport is WS-backed (browser server mode OR cloud-linked Electron);
 *   `null` in standalone Electron. Exposed so callers can register
 *   reverse-RPC handlers + connect listeners.
 */
type TransportBundle = {
  emitter: TransportEmitter;
  localEmitter: TransportEmitter;
  ipc: TransportListener;
  wsEmitter: WsTransportEmitter | null;
};

const createTransport = (): TransportBundle => {
  // Electron + cloud-linked → bootstrap a WS against the cloud launcher.
  // ws-token fetching is delegated to main via cloud:get-ws-token because
  // the renderer's cross-origin GET + Bearer would trip CORS preflight and
  // EasyAuth's 302-to-AAD on the OPTIONS preflight fails CORS. Main has
  // the Entra access token and fetches /api/ws-token from Node (no CORS).
  if (isElectron && bootstrap.cloudMode) {
    const electronEmitter = new ElectronTransportEmitter();
    const wsEmitter = new WsTransportEmitter({
      baseUrl: bootstrap.cloudMode.url,
      getWsToken: async () => {
        return (await electronEmitter.invoke('cloud:get-ws-token')) as string;
      },
    });
    return {
      emitter: wsEmitter,
      localEmitter: electronEmitter,
      ipc: new WsTransportListener(wsEmitter),
      wsEmitter,
    };
  }

  if (isElectron) {
    const electronEmitter = new ElectronTransportEmitter();
    return {
      emitter: electronEmitter,
      localEmitter: electronEmitter,
      ipc: new ElectronTransportListener(),
      wsEmitter: null,
    };
  }

  const wsEmitter = new WsTransportEmitter();
  return {
    emitter: wsEmitter,
    localEmitter: wsEmitter,
    ipc: new WsTransportListener(wsEmitter),
    wsEmitter,
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

/**
 * Electron-IPC-only emitter for channels that ALWAYS resolve in local main —
 * cloud-link handlers (`cloud:link`, `cloud:get-ws-token`, `cloud:get-machine-
 * identity`, `cloud:set-machine-label`), local file dialogs, etc. In
 * standalone Electron and browser/server mode this is the same as
 * {@link emitter}; in cloud-linked Electron it is the local Electron IPC and
 * therefore does NOT route over the cloud WS.
 */
export const localEmitter: TransportEmitter = transport.localEmitter;

/**
 * The underlying WS transport when active (browser server mode + cloud-linked
 * Electron); `null` in standalone Electron. Exposed so the compute layer can
 * register reverse-RPC handlers and replay setup work on reconnect.
 */
export const wsEmitter: import('@/renderer/transport/ws-transport').WsTransportEmitter | null = transport.wsEmitter;
