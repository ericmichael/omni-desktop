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

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

/**
 * WebSocket-based transport emitter for browser mode.
 * Sends JSON-RPC-like invoke messages and waits for responses.
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

  constructor() {
    this.connect();
  }

  private getWsUrl(): string {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws?sessionId=${encodeURIComponent(this.sessionId)}`;
  }

  private connect(): void {
    const ws = new WebSocket(this.getWsUrl());

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
      this.connect();
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
