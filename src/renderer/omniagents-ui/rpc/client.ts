import { createActor } from 'xstate';

import { createMachineLogger } from '@/shared/machines/machine-logger';
import {
  MAX_PENDING_CALLS,
  RPC_CALL_TIMEOUT_MS,
  rpcClientMachine,
  type RPCClientActor,
} from '@/shared/machines/rpc-client.machine';

type JSONRPCId = number | string

type JSONRPCRequest = {
  jsonrpc: '2.0'
  id: JSONRPCId
  method: string
  params?: Record<string, unknown>
}

type JSONRPCResponse = {
  jsonrpc: '2.0'
  id: JSONRPCId
  result?: unknown
  error?: { code?: number; message: string; data?: unknown }
}

type JSONRPCNotification = {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type ServerEvent = JSONRPCNotification

type Listener = (payload: any) => void

type PendingEntry = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RPCClient {
  private ws: WebSocket | null = null
  private url: string
  private token?: string
  private nextId = 0
  private pending = new Map<JSONRPCId, PendingEntry>()
  private listeners = new Map<string, Set<Listener>>()
  private disposed = false
  private reconnectSub: { unsubscribe(): void } | null = null
  private connectInFlight: Promise<void> | null = null
  readonly actor: RPCClientActor

  constructor(url: string, token?: string) {
    this.url = url
    this.token = token
    this.actor = createActor(rpcClientMachine, {
      input: { url, token },
      inspect: createMachineLogger('rpc', { tags: { url } }),
    })
    this.actor.start()

    // Wire up automatic reconnection: when the machine transitions to
    // `connecting` from `reconnecting`, open a new WebSocket.
    // The machine handles backoff timing — we just need to create the socket.
    this.reconnectSub = this.actor.subscribe((snap) => {
      if (snap.value === 'connecting' && snap.context.reconnectAttempt > 0 && !this.disposed) {
        this.connect().catch(() => {})
      }
    })
  }

  /** Send event to the machine only if not disposed. */
  private send(event: import('@/shared/machines/rpc-client.machine').RPCClientEvent): void {
    if (this.disposed) return
    this.actor.send(event)
  }

  /** Current connection state from the machine. */
  get connectionState(): 'disconnected' | 'connecting' | 'connected' | 'reconnecting' {
    if (this.disposed) return 'disconnected'
    return this.actor.getSnapshot().value as any
  }

  /** True when the WebSocket is open and ready for calls. */
  get isConnected(): boolean {
    return this.connectionState === 'connected'
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('RPCClient is disposed')

    if (this.connectInFlight) {
      return this.connectInFlight
    }

    // If already connected, noop
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return
    }

    const connectPromise = this.connectImpl()
    this.connectInFlight = connectPromise
    connectPromise.finally(() => {
      if (this.connectInFlight === connectPromise) {
        this.connectInFlight = null
      }
    })
    return connectPromise
  }

  private async connectImpl(): Promise<void> {
    if (this.disposed) throw new Error('RPCClient is disposed')

    // Clean up any previous WebSocket that isn't open (e.g. CLOSING, CLOSED,
    // or still CONNECTING from a previous failed attempt) to avoid leaking
    // sockets through the proxy on each reconnection attempt.
    if (this.ws) {
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      try { this.ws.close() } catch {}
      this.ws = null
    }

    this.send({ type: 'CONNECT' })

    const wsUrl = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      // Guard: ignore events from stale WebSocket instances (e.g. after disconnect()
      // closes this WS while a new connect() has already started with a different one).
      const isStale = () => this.ws !== ws
      const onOpen = () => {
        cleanup()
        if (isStale()) return
        this.send({ type: 'WS_OPEN' })
        resolve()
      }
      const onError = () => {
        cleanup()
        if (isStale()) { reject(new Error('WebSocket replaced')); return }
        this.send({ type: 'WS_ERROR', error: 'WebSocket connection error' })
        reject(new Error('WebSocket error'))
      }
      const onClose = () => {
        cleanup()
        if (isStale()) { reject(new Error('WebSocket replaced')); return }
        this.send({ type: 'WS_CLOSE' })
        reject(new Error('WebSocket closed during connect'))
      }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })

    if (!this.ws) throw new Error('WebSocket disconnected')

    // Wire up ongoing message handling
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as JSONRPCResponse | JSONRPCNotification
        if ('id' in msg) {
          const pending = this.pending.get(msg.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(msg.id)
            this.send({ type: 'CALL_SETTLED' })
            if ((msg as JSONRPCResponse).error) {
              pending.reject(new Error((msg as JSONRPCResponse).error!.message))
            } else {
              pending.resolve((msg as JSONRPCResponse).result)
            }
          }
        } else {
          const evt = msg as JSONRPCNotification
          this.emitEvent(evt.method, evt.params)
        }
      } catch (e) {
        console.error('RPC parse error', e)
      }
    }

    // Handle unexpected close — reject all pending, notify machine
    this.ws.onclose = () => {
      this.rejectAllPending('WebSocket connection closed')
      this.ws = null
      this.send({ type: 'WS_CLOSE' })
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  disconnect(): void {
    this.rejectAllPending('Client disconnected')
    this.connectInFlight = null
    if (this.ws) {
      // Clear handlers before close to prevent stale onclose from firing
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.close()
      this.ws = null
    }
    this.send({ type: 'DISCONNECT' })
  }

  /**
   * Connect and wait for the machine to reach `connected` state.
   * Leverages the machine's built-in reconnection with exponential backoff.
   * Rejects if the machine gives up (max attempts) or on timeout.
   */
  async connectAndWait(timeoutMs = 60_000): Promise<void> {
    if (this.disposed) throw new Error('RPCClient is disposed')
    if (this.isConnected) return

    // Kick off the initial connection attempt
    this.connect().catch(() => {})

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.unsubscribe()
        reject(new Error('Connection timed out'))
      }, timeoutMs)

      const sub = this.actor.subscribe((snap) => {
        if (snap.value === 'connected') {
          clearTimeout(timeout)
          sub.unsubscribe()
          resolve()
        } else if (snap.value === 'disconnected' && snap.context.error) {
          // Machine gave up (max reconnect attempts reached)
          clearTimeout(timeout)
          sub.unsubscribe()
          reject(new Error(snap.context.error))
        }
      })
    })
  }

  /** Stop the state machine actor. Call when disposing the client permanently. */
  dispose(): void {
    this.disposed = true
    this.reconnectSub?.unsubscribe()
    this.reconnectSub = null
    this.connectInFlight = null
    this.disconnect()
    this.actor.stop()
  }

  on(event: string, handler: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    const set = this.listeners.get(event)!
    set.add(handler)
    return () => set.delete(handler)
  }

  private emitEvent(event: string, payload: any): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try { fn(payload) } catch {}
    }
  }

  private async call<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }
    if (this.pending.size >= MAX_PENDING_CALLS) {
      throw new Error(`RPC pending queue full (max ${MAX_PENDING_CALLS})`)
    }

    const id = ++this.nextId
    const req: JSONRPCRequest = { jsonrpc: '2.0', id, method, params }

    const p = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.send({ type: 'CALL_SETTLED' })
          reject(new Error(`RPC call '${method}' timed out after ${RPC_CALL_TIMEOUT_MS}ms`))
        }
      }, RPC_CALL_TIMEOUT_MS)

      this.pending.set(id, { resolve: resolve as any, reject, timer })
      this.send({ type: 'CALL_STARTED' })
    })

    this.ws.send(JSON.stringify(req))
    return p
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    // Reset pending count in machine
    const snapshot = this.actor.getSnapshot()
    if (snapshot.context.pendingCount > 0) {
      // Send enough CALL_SETTLED events to zero it out
      for (let i = 0; i < snapshot.context.pendingCount; i++) {
        this.send({ type: 'CALL_SETTLED' })
      }
    }
  }

  // -----------------------------------------------------------------------
  // RPC methods — unchanged public API
  // -----------------------------------------------------------------------

  async startRun(prompt: string, sessionId?: string, variables?: Record<string, unknown>, content?: unknown): Promise<{ run_id: string; session_id: string }> {
    const params: Record<string, unknown> = { prompt }
    if (sessionId) params.session_id = sessionId
    if (variables) params.variables = variables
    if (content != null) params.content = content
    return this.call('start_run', params)
  }

  async stopRun(runId: string): Promise<void> {
    await this.call('stop_run', { run_id: runId })
  }

  async getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: unknown; timestamp: string }>> {
    return this.call('get_session_history', { session_id: sessionId })
  }

  async listSessions(): Promise<Array<{ id: string; created_at: string; archived: boolean; message_count: number; first_message?: unknown; last_message?: unknown }>> {
    return this.call('list_sessions', {})
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.call('delete_session', { session_id: sessionId })
  }

  async clientResponse(requestId: string, ok: boolean, result?: Record<string, unknown>, error?: Record<string, unknown>): Promise<void> {
    const params: Record<string, unknown> = { request_id: requestId, ok }
    if (result) params.result = result
    if (error) params.error = error
    await this.call('client_response', params)
  }

  async listServerFunctions(): Promise<Array<{ name: string; description?: string; params_schema?: Record<string, unknown>; result_schema?: Record<string, unknown> }>> {
    return this.call('list_server_functions', {})
  }

  async serverCall(func: string, args?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { function: func }
    if (args) params.args = args
    if (sessionId) params.session_id = sessionId
    return this.call('server_call', params)
  }

  async clientFunctions(version: number, functions: Array<{ name: string; description?: string }>): Promise<void> {
    await this.call('client_functions', { version, functions })
  }

  async getAgentInfo(): Promise<{ name?: string; header_title?: string; page_title?: string; welcome_text?: string; page_title_suffix?: string; theme_color?: string }> {
    return this.call('get_agent_info', {})
  }
}
