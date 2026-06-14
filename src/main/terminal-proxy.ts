import { WebSocket } from 'ws';

import type { ProcessManager } from '@/main/process-manager';
import type { IpcRendererEvents } from '@/shared/types';

/**
 * Bridges `terminal:*` IPC to `omni serve`'s WebSocket protocol so the
 * shell runs inside the sandbox (via `omniagents.rpc.terminal.TerminalManager`
 * backed by `SessionPtyBackend`), not as a host child of the launcher.
 *
 * Two WebSockets per terminal:
 *   - One JSON-RPC connection (`/ws`) shared across all terminals on a
 *     given tab, used to call `session.ensure` and `terminal.create`.
 *   - One I/O socket (`/ws/terminal`) per terminal, opened with the
 *     `terminal_id`/`terminal_token` returned by `terminal.create`.
 *
 * Closing the I/O socket triggers `close_terminal` on the omni serve side
 * automatically (see `omniagents/backends/server/app.py` finally block) —
 * no explicit `terminal.close` RPC needed.
 */

type WindowSender = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

export type ConsoleErrorKind =
  | 'process_not_ready'
  | 'rpc_failed'
  | 'session_unavailable'
  | 'terminal_unavailable'
  | 'backend_no_pty_stream';

export class ConsoleError extends Error {
  readonly kind: ConsoleErrorKind;

  constructor(kind: ConsoleErrorKind, message: string) {
    super(message);
    this.name = 'ConsoleError';
    this.kind = kind;
  }
}

type ProxiedTerminal = {
  id: string;
  tabId: string;
  serveTerminalId: string;
  serveSessionId: string;
  token: string;
  ioSocket: WebSocket;
  disposing: boolean;
};

type RpcCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type TabRpc = {
  socket: WebSocket;
  ready: Promise<void>;
  pending: Map<number, RpcCall>;
  nextId: number;
  /** Session id created via `session.ensure` — shared by every terminal in this tab. */
  sessionId: string | null;
  /** Resolved after the first session.ensure completes. */
  sessionReady: Promise<string> | null;
};

const RPC_TIMEOUT_MS = 15_000;

export class TerminalProxy {
  private terminals = new Map<string, ProxiedTerminal>();
  private tabRpc = new Map<string, TabRpc>();

  constructor(
    private readonly deps: {
      processManager: ProcessManager;
      sendToWindow: WindowSender;
    }
  ) {}

  async create(tabId: string): Promise<string> {
    const status = this.deps.processManager.getStatus(tabId);
    if ((status.type !== 'running' && status.type !== 'connecting') || !('data' in status) || !status.data.wsUrl) {
      throw new ConsoleError('process_not_ready', 'Open a code session before launching a terminal.');
    }
    const wsUrl = status.data.wsUrl;

    const rpc = await this.ensureTabRpc(tabId, wsUrl);
    const sessionId = await this.ensureSession(rpc);

    // We deliberately do not send `cwd` here. The terminal cwd is the
    // backend's call: profile `terminal.cwd` for sandbox-backed shells,
    // the SDK's manifest root for host-backed. The launcher renderer
    // has no way to express in-container paths today, so any value it
    // sent would be a host path that doesn't exist inside the sandbox.
    const created = await this.rpcCall(rpc, 'server_call', {
      function: 'terminal.create',
      args: { cols: 80, rows: 24 },
      session_id: sessionId,
    });
    if (!isObject(created)) {
      throw new ConsoleError('rpc_failed', 'terminal.create returned an unexpected payload');
    }
    const serveTerminalId = String(created['terminal_id'] ?? '').trim();
    const token = String(created['terminal_token'] ?? created['token'] ?? '').trim();
    const path = String(created['path'] ?? '/ws/terminal').trim() || '/ws/terminal';
    const serveSessionId = String(created['session_id'] ?? sessionId).trim();
    if (!serveTerminalId || !token) {
      throw new ConsoleError('terminal_unavailable', 'omni serve did not return a usable terminal');
    }

    const ioUrl = this.buildTerminalUrl(wsUrl, path, {
      session_id: serveSessionId,
      terminal_id: serveTerminalId,
      terminal_token: token,
    });
    const ioSocket = new WebSocket(ioUrl);
    const entry: ProxiedTerminal = {
      id: serveTerminalId,
      tabId,
      serveTerminalId,
      serveSessionId,
      token,
      ioSocket,
      disposing: false,
    };
    this.terminals.set(serveTerminalId, entry);

    ioSocket.on('message', (raw) => this.handleIoMessage(entry, raw));
    ioSocket.on('close', () => {
      const exitCode = 0;
      this.terminals.delete(entry.id);
      if (!entry.disposing) {
        this.deps.sendToWindow('terminal:exited', entry.tabId, entry.id, exitCode);
      }
    });
    ioSocket.on('error', (err) => {
      console.error('[TerminalProxy] /ws/terminal error', err);
    });

    return serveTerminalId;
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    if (!entry || entry.disposing) {
      return;
    }
    if (entry.ioSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    entry.ioSocket.send(
      JSON.stringify({
        type: 'input',
        data: Buffer.from(data, 'utf-8').toString('base64'),
      })
    );
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    if (!entry || entry.disposing) {
      return;
    }
    if (entry.ioSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    entry.ioSocket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  async dispose(id: string): Promise<void> {
    const entry = this.terminals.get(id);
    if (!entry) {
      return;
    }
    entry.disposing = true;
    try {
      if (entry.ioSocket.readyState === WebSocket.OPEN) {
        entry.ioSocket.send(JSON.stringify({ type: 'close' }));
      }
    } catch {
      // socket might already be dead
    }
    try {
      entry.ioSocket.close();
    } catch {
      // ignore
    }
    this.terminals.delete(id);
  }

  async disposeAllForTab(tabId: string): Promise<void> {
    const ids = [...this.terminals.values()].filter((t) => t.tabId === tabId).map((t) => t.id);
    await Promise.allSettled(ids.map((id) => this.dispose(id)));
    const rpc = this.tabRpc.get(tabId);
    if (rpc) {
      this.tabRpc.delete(tabId);
      this.failPendingRpc(rpc, new ConsoleError('rpc_failed', 'tab disposed'));
      try {
        rpc.socket.close();
      } catch {
        // ignore
      }
    }
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.terminals.keys()];
    await Promise.allSettled(ids.map((id) => this.dispose(id)));
    const tabIds = [...this.tabRpc.keys()];
    for (const tabId of tabIds) {
      const rpc = this.tabRpc.get(tabId);
      if (!rpc) {
        continue;
      }
      this.tabRpc.delete(tabId);
      this.failPendingRpc(rpc, new ConsoleError('rpc_failed', 'shutting down'));
      try {
        rpc.socket.close();
      } catch {
        // ignore
      }
    }
  }

  listIdsForTab(tabId: string): string[] {
    return [...this.terminals.values()].filter((t) => t.tabId === tabId).map((t) => t.id);
  }

  // ----------------------------- internals -----------------------------

  private handleIoMessage(entry: ProxiedTerminal, raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObject(msg)) {
      return;
    }
    const type = msg['type'];
    if (type === 'output') {
      const data = String(msg['data'] ?? '');
      if (!data) {
        return;
      }
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
      this.deps.sendToWindow('terminal:output', entry.tabId, entry.id, decoded);
      return;
    }
    if (type === 'exit') {
      const codeRaw = msg['code'];
      const code = typeof codeRaw === 'number' ? codeRaw : 0;
      entry.disposing = true;
      this.terminals.delete(entry.id);
      this.deps.sendToWindow('terminal:exited', entry.tabId, entry.id, code);
      try {
        entry.ioSocket.close();
      } catch {
        // ignore
      }
    }
  }

  private async ensureTabRpc(tabId: string, wsUrl: string): Promise<TabRpc> {
    const existing = this.tabRpc.get(tabId);
    if (existing) {
      await existing.ready;
      if (existing.socket.readyState === WebSocket.OPEN) {
        return existing;
      }
      this.tabRpc.delete(tabId);
    }

    const socket = new WebSocket(wsUrl);
    const rpc: TabRpc = {
      socket,
      pending: new Map(),
      nextId: 1,
      sessionId: null,
      sessionReady: null,
      ready: new Promise((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', (err) => reject(err));
      }),
    };

    socket.on('message', (raw) => this.handleRpcMessage(rpc, raw));
    socket.on('close', () => {
      this.failPendingRpc(rpc, new ConsoleError('rpc_failed', '/ws connection closed'));
      if (this.tabRpc.get(tabId) === rpc) {
        this.tabRpc.delete(tabId);
      }
    });
    socket.on('error', () => {
      // Errors are surfaced via the per-call rejection; the close handler
      // cleans up state.
    });

    this.tabRpc.set(tabId, rpc);
    try {
      await rpc.ready;
    } catch (err) {
      this.tabRpc.delete(tabId);
      throw new ConsoleError('rpc_failed', `failed to open /ws to omni serve: ${(err as Error).message ?? err}`);
    }
    return rpc;
  }

  private async ensureSession(rpc: TabRpc): Promise<string> {
    if (rpc.sessionId) {
      return rpc.sessionId;
    }
    if (rpc.sessionReady) {
      return rpc.sessionReady;
    }
    rpc.sessionReady = (async () => {
      const res = await this.rpcCall(rpc, 'server_call', {
        function: 'session.ensure',
        args: {},
      });
      if (!isObject(res)) {
        throw new ConsoleError('session_unavailable', 'session.ensure returned no payload');
      }
      const sid = String(res['session_id'] ?? '').trim();
      if (!sid) {
        throw new ConsoleError('session_unavailable', 'session.ensure returned no session_id');
      }
      rpc.sessionId = sid;
      return sid;
    })();
    return rpc.sessionReady;
  }

  private rpcCall(rpc: TabRpc, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = rpc.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        rpc.pending.delete(id);
        reject(new ConsoleError('rpc_failed', `${method} timed out`));
      }, RPC_TIMEOUT_MS);
      rpc.pending.set(id, { resolve, reject, timer });
      try {
        rpc.socket.send(payload);
      } catch (err) {
        clearTimeout(timer);
        rpc.pending.delete(id);
        reject(new ConsoleError('rpc_failed', `${method} send failed: ${(err as Error).message ?? err}`));
      }
    });
  }

  private handleRpcMessage(rpc: TabRpc, raw: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObject(msg)) {
      return;
    }
    const id = msg['id'];
    if (typeof id !== 'number') {
      return;
    }
    const pending = rpc.pending.get(id);
    if (!pending) {
      return;
    }
    rpc.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in msg && isObject(msg['error'])) {
      const errMsg = String((msg['error'] as Record<string, unknown>)['message'] ?? 'rpc error');
      pending.reject(new ConsoleError('rpc_failed', errMsg));
      return;
    }
    pending.resolve(msg['result']);
  }

  private failPendingRpc(rpc: TabRpc, err: Error): void {
    for (const [, p] of rpc.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    rpc.pending.clear();
  }

  private buildTerminalUrl(rpcWsUrl: string, path: string, params: Record<string, string>): string {
    // rpcWsUrl is like `ws://host:port/ws?token=...`; we keep host, port,
    // and the token query param (the /ws/terminal route validates the
    // same token).
    const u = new URL(rpcWsUrl);
    const tokenParam = u.searchParams.get('token');
    u.pathname = path;
    u.search = '';
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(k, v);
    }
    if (tokenParam) {
      u.searchParams.set('token', tokenParam);
    }
    return u.toString();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
