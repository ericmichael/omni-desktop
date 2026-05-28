import type { TransportEmitter, TransportListener } from '@/shared/transport';
import type { IpcEvents, IpcRendererEvents } from '@/shared/types';

type InvokeMessage = {
  type: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
};

type ResponseMessage = {
  type: 'response';
  id: number;
  result?: unknown;
  error?: string;
};

type EventMessage = {
  type: 'event';
  channel: string;
  args: unknown[];
};

type ServerMessage = ResponseMessage | EventMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const INITIAL_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 10_000;

const SESSION_ID_KEY = 'omni-session-id';
/** Active team id (teams/cloud mode); sent as ?team= so the server scopes the session. */
const ACTIVE_TEAM_KEY = 'omni-active-team';

import { uuidv4 } from '@/lib/uuid';

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = uuidv4();
    localStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

/** Persisted active team, or null until the user picks one (defaults to their personal team). */
export function getActiveTeamId(): string | null {
  return localStorage.getItem(ACTIVE_TEAM_KEY);
}

/** Set the active team and reconnect the socket so the server re-scopes the session. */
export function setActiveTeamId(teamId: string): void {
  localStorage.setItem(ACTIVE_TEAM_KEY, teamId);
  // A full reload is the simplest correct reconnect: it re-dials /ws with the
  // new ?team= and re-hydrates every store from the new scope.
  location.reload();
}

/**
 * Optional cloud-link configuration. When set, ``WsTransportEmitter`` opens
 * the WebSocket against the cloud at *baseUrl* and delegates ws-token
 * acquisition to *getWsToken* (which runs in the Electron main process —
 * it has the Entra access token and can call ``/api/ws-token`` without
 * tripping CORS preflight that the renderer's cross-origin fetch would).
 * Browser server-mode leaves the config unset and keeps the same-origin
 * fetch behaviour.
 */
export type WsTransportConfig = {
  /** Absolute origin of the cloud launcher, e.g. ``https://omni.example.com``. */
  baseUrl: string;
  /** Resolver for a fresh WS auth token. In Electron cloud mode this crosses
   *  the preload bridge to main, which fetches /api/ws-token with a Bearer. */
  getWsToken: () => Promise<string>;
};

/**
 * WebSocket-based transport emitter. Two modes:
 *   - Browser server-mode: same-origin /api/ws-token + ws://<host>/ws.
 *   - Cloud-linked Electron: absolute baseUrl + Bearer header to the cloud,
 *     WS upgrade against the same host.
 */
export class WsTransportEmitter implements TransportEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: string[] = [];
  private sessionId = getOrCreateSessionId();
  private authToken: string | null = null;
  private readonly cloud: WsTransportConfig | null;
  private readonly wsHost: string;

  constructor(cloud?: WsTransportConfig) {
    this.cloud = cloud ?? null;
    // Pre-compute the WS host once. For browser mode use ``location.host``
    // (the SPA's origin); for cloud-linked Electron the renderer is loaded
    // from a file:// URL so ``location`` is useless and we derive the host
    // from cloud.baseUrl.
    if (cloud) {
      try {
        this.wsHost = new URL(cloud.baseUrl).host;
      } catch {
        throw new Error(`WsTransportEmitter: invalid cloud baseUrl: ${cloud.baseUrl}`);
      }
    } else {
      this.wsHost = location.host;
    }
    void this.connect();
  }

  private isHttps(): boolean {
    if (this.cloud) {
      try {
        return new URL(this.cloud.baseUrl).protocol === 'https:';
      } catch {
        return false;
      }
    }
    return location.protocol === 'https:';
  }

  private async fetchAuthToken(): Promise<string> {
    if (this.authToken) {
      return this.authToken;
    }
    // Cloud-linked Electron: delegate to main (cross-origin fetch + Bearer
    // would trip CORS preflight; EasyAuth's redirect on the OPTIONS request
    // fails it). Browser server-mode: same-origin cookie auth.
    if (this.cloud) {
      this.authToken = await this.cloud.getWsToken();
      return this.authToken;
    }
    const res = await fetch('/api/ws-token', { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error(`Failed to fetch WS auth token: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error('WS auth token response missing token');
    }
    this.authToken = data.token;
    return data.token;
  }

  private getWsUrl(token: string): string {
    const protocol = this.isHttps() ? 'wss:' : 'ws:';
    const team = getActiveTeamId();
    const teamParam = team ? `&team=${encodeURIComponent(team)}` : '';
    return `${protocol}//${this.wsHost}/ws?sessionId=${encodeURIComponent(this.sessionId)}&token=${encodeURIComponent(token)}${teamParam}`;
  }

  private async connect(): Promise<void> {
    let token: string;
    try {
      token = await this.fetchAuthToken();
    } catch (err) {
      console.error('[ws-transport]', err);
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(this.getWsUrl(token));

    ws.onopen = () => {
      this.ws = ws;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;

      // Flush queued messages
      for (const msg of this.messageQueue) {
        ws.send(msg);
      }
      this.messageQueue = [];
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === 'response') {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.type === 'event') {
        const channelListeners = this.listeners.get(msg.channel);
        if (channelListeners) {
          for (const listener of channelListeners) {
            listener(...msg.args);
          }
        }
      }
    };

    ws.onclose = () => {
      this.ws = null;
      // Bust the cached ws-token. The server's signed tokens are short-TTL
      // and a stale one (e.g. cached across a server redeploy that rotated
      // the signing secret, or just past its 5-min TTL) would spin the
      // reconnect loop indefinitely — every dial would fail with the same
      // bad token and the cache would never refresh.
      this.authToken = null;
      // Reject all pending requests
      for (const [id, pending] of this.pending) {
        pending.reject(new Error('WebSocket connection closed'));
        this.pending.delete(id);
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(MAX_RECONNECT_DELAY, Math.round(this.reconnectDelay * 1.5));
      void this.connect();
    }, this.reconnectDelay);
  }

  private send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
    }
  }

  invoke<E extends keyof IpcEvents>(channel: E, ...args: Parameters<IpcEvents[E]>): Promise<ReturnType<IpcEvents[E]>> {
    const id = this.nextId++;
    const message: InvokeMessage = { type: 'invoke', id, channel: channel as string, args };

    return new Promise<ReturnType<IpcEvents[E]>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.send(JSON.stringify(message));
    });
  }

  /** Register an event listener (used by WsTransportListener). */
  addListener(channel: string, listener: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);

    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(channel);
      }
    };
  }
}

/**
 * WebSocket-based transport listener for browser mode.
 * Receives push events from the server over the shared WebSocket connection.
 */
export class WsTransportListener implements TransportListener {
  private wsEmitter: WsTransportEmitter;

  constructor(wsEmitter: WsTransportEmitter) {
    this.wsEmitter = wsEmitter;
  }

  on<E extends keyof IpcRendererEvents>(channel: E, listener: (...args: IpcRendererEvents[E]) => void): () => void {
    return this.wsEmitter.addListener(channel as string, listener as (...args: unknown[]) => void);
  }
}
