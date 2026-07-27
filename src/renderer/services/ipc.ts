import { ElectronTransportEmitter, ElectronTransportListener } from '@/renderer/transport/electron-transport';
import { WsTransportEmitter, WsTransportListener } from '@/renderer/transport/ws-transport';
import type { TransportEmitter, TransportListener } from '@/shared/transport';
import type { RemoteBackendBootstrap } from '@/shared/types';

/**
 * True in the Electron desktop app, false in the browser/server build. Drives
 * hiding controls that are no-ops in hosted mode (host-filesystem pickers, the
 * runtime installer, the in-PATH CLI, launcher auto-update, local-file imports).
 */
export const isElectron = typeof window !== 'undefined' && 'electron' in window;

/**
 * Preload-injected bootstrap data. ``remoteBackend`` is the persisted
 * ``StoreData.remoteBackend`` (wsl kind resolved to its live URL), copied
 * into the window at BrowserWindow creation (see main-process-manager.ts +
 * preload/index.ts). Non-null means the Electron app is linked to a remote
 * launcher backend — a deployed cloud (``kind: 'cloud'``), the WSL daemon
 * on this machine (``kind: 'wsl'``), or a self-hosted server-mode launcher
 * (``kind: 'server'``) — and the renderer should route its transport over
 * WebSocket to ``url``. ``platform`` is ``process.platform`` from preload;
 * ``null`` in the browser build.
 */
type OmniBootstrap = { remoteBackend: RemoteBackendBootstrap | null; platform: string | null };
const bootstrap: OmniBootstrap = ((): OmniBootstrap => {
  const fromWindow =
    (typeof window !== 'undefined'
      ? (window as unknown as { __omniBootstrap?: OmniBootstrap }).__omniBootstrap
      : undefined) ?? null;
  return fromWindow ?? { remoteBackend: null, platform: null };
})();

/**
 * True when this Electron renderer is linked to a deployed cloud launcher.
 * Gates cloud-only behavior: machine registration, compute reverse-RPC,
 * tunnel bridge, and the Settings "Disconnect from cloud" affordance. WSL
 * and self-hosted server backends never count as cloud-linked.
 */
export const isCloudLinked = isElectron && bootstrap.remoteBackend?.kind === 'cloud';

/**
 * True when this Electron renderer is linked to the WSL backend daemon on
 * this machine. Transport-wise identical to cloud-linked (WS to
 * ``remoteBackend.url``); auth is the local `wsl:get-ws-token` mint instead
 * of the cloud's Entra-backed token fetch.
 */
export const isWslLinked = isElectron && bootstrap.remoteBackend?.kind === 'wsl';

/**
 * True when this Electron renderer is linked to a self-hosted server-mode
 * launcher. Transport-wise identical to cloud-linked (WS to
 * ``remoteBackend.url``); auth is `server:get-ws-token` — main fetching the
 * server's own ``/api/ws-token`` — with no identity behind it, so none of
 * the cloud-only behavior (machines, compute, tunnel) activates.
 */
export const isServerLinked = isElectron && bootstrap.remoteBackend?.kind === 'server';

/** ``process.platform`` from preload (e.g. ``'win32'``); ``null`` in the browser build. */
export const bootstrapPlatform: string | null = bootstrap.platform;

/**
 * The origin the launcher actually lives at — the same origin that serves
 * ``/proxy/...`` reverse-proxy routes, ``/api/...`` endpoints, and the WS
 * upgrade target. Browser server-mode = same-origin (``window.location.origin``).
 * Remote-linked Electron (cloud, wsl, or server) = the backend's baseUrl, because the
 * renderer is loaded from ``localhost:5173`` (dev) or ``file://`` (prod) —
 * neither of which can resolve the launcher's relative URLs.
 *
 * Use this anywhere the renderer would otherwise reach for
 * ``window.location.origin`` to talk to the launcher (iframe srcs derived
 * from ``/proxy/...`` payloads, ``fetch('/proxy/_register', …)``, WebSocket
 * base URL builders, etc.). Don't use it for renderer-local concerns
 * (intra-window navigation, asset loading from the renderer's own bundle).
 */
export const serverOrigin = (): string => bootstrap.remoteBackend?.url ?? location.origin;

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
 *   it is `WsTransportEmitter` (renderer → server WS). In remote-linked
 *   Electron (cloud, wsl, or server) it routes invokes to the backend WS — so it must
 *   NOT be used for channels handled only in local main (link flows, machine
 *   identity, shell dialogs, etc.); those use {@link localEmitter} instead.
 * - `localEmitter` is Electron IPC → local main. In remote-linked Electron it
 *   is a separate `ElectronTransportEmitter`; in every other mode it equals
 *   `emitter`. Callers don't need to branch — they pick the right emitter
 *   based on which side handles the channel.
 * - `ipc` listens for server-pushed events (main → renderer / backend → renderer).
 * - `wsEmitter` is the underlying WsTransportEmitter when the active
 *   transport is WS-backed (browser server mode OR remote-linked Electron);
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
  // Electron + remote-linked → bootstrap a WS against the remote backend.
  // ws-token fetching is delegated to main in all kinds: for cloud because
  // the renderer's cross-origin GET + Bearer would trip CORS preflight and
  // EasyAuth's 302-to-AAD on the OPTIONS preflight fails CORS (main has the
  // Entra access token and fetches /api/ws-token from Node, no CORS); for
  // wsl because main holds the daemon's per-boot shared secret and mints
  // the token locally; for server because the renderer's cross-origin GET
  // would need the server to speak CORS (main's Node fetch doesn't).
  if (isElectron && bootstrap.remoteBackend) {
    const remoteBackend = bootstrap.remoteBackend;
    const electronEmitter = new ElectronTransportEmitter();
    const wsEmitter = new WsTransportEmitter({
      baseUrl: remoteBackend.url,
      getWsToken: async () => {
        switch (remoteBackend.kind) {
          case 'wsl':
            return (await electronEmitter.invoke('wsl:get-ws-token')) as string;
          case 'server':
            return (await electronEmitter.invoke('server:get-ws-token')) as string;
          case 'cloud':
            return (await electronEmitter.invoke('cloud:get-ws-token')) as string;
        }
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
 * link handlers (`cloud:*`, `wsl:*`, `server:*`), local file dialogs, etc. In
 * standalone Electron and browser/server mode this is the same as
 * {@link emitter}; in remote-linked Electron it is the local Electron IPC and
 * therefore does NOT route over the backend WS.
 */
export const localEmitter: TransportEmitter = transport.localEmitter;

/**
 * The underlying WS transport when active (browser server mode + remote-linked
 * Electron); `null` in standalone Electron. Exposed so the compute layer can
 * register reverse-RPC handlers and replay setup work on reconnect.
 */
export const wsEmitter: import('@/renderer/transport/ws-transport').WsTransportEmitter | null = transport.wsEmitter;
