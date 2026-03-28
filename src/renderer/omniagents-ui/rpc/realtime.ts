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

type Listener = (payload: any) => void

export class RealtimeRPCClient {
  private ws: WebSocket | null = null
  private url: string
  private token?: string
  private debug: boolean = false
  private nextId = 0
  private pending = new Map<JSONRPCId, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()
  private intentionalClose = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static MAX_RECONNECT_DELAY = 10_000

  constructor(url: string, token?: string, debug?: boolean) {
    this.url = url
    this.token = token
    this.debug = !!debug
  }

  async connect(): Promise<void> {
    this.intentionalClose = false
    this.reconnectAttempt = 0
    await this.connectInternal()
  }

  private async connectInternal(): Promise<void> {
    const wsUrl = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url
    if (this.debug) console.log('[rpc] connect', wsUrl)
    this.ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket init failed'))
      this.ws.onopen = () => {
        if (this.debug) console.log('[rpc] open')
        this.reconnectAttempt = 0
        resolve()
      }
      this.ws.onerror = (e) => {
        if (this.debug) console.error('[rpc] error', e)
        reject(new Error('WebSocket error'))
      }
    })
    if (!this.ws) throw new Error('WebSocket disconnected')
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as JSONRPCResponse | JSONRPCNotification
        if (this.debug) console.log('[rpc] recv', msg)
        if ('id' in msg) {
          const pending = this.pending.get(msg.id)
          if (pending) {
            this.pending.delete(msg.id)
            if ((msg as JSONRPCResponse).error) pending.reject(new Error((msg as JSONRPCResponse).error!.message))
            else pending.resolve((msg as JSONRPCResponse).result)
          }
        } else {
          const evt = msg as JSONRPCNotification
          this.emit(evt.method, evt.params)
        }
      } catch (e) {
        if (this.debug) console.error('[rpc] parse error', e)
      }
    }
    this.ws.onclose = (e) => {
      if (this.debug) console.log('[rpc] close', e?.code, e?.reason)
      // Reject all pending RPCs
      for (const [id, p] of this.pending) {
        p.reject(new Error('WebSocket closed'))
        this.pending.delete(id)
      }
      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, RealtimeRPCClient.MAX_RECONNECT_DELAY)
    this.reconnectAttempt++
    if (this.debug) console.log(`[rpc] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectInternal()
        if (this.debug) console.log('[rpc] reconnected')
      } catch {
        if (!this.intentionalClose) {
          this.scheduleReconnect()
        }
      }
    }, delay)
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  on(event: string, handler: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    const set = this.listeners.get(event)!
    set.add(handler)
    return () => set.delete(handler)
  }

  private emit(event: string, payload: any): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try { fn(payload) } catch {}
    }
  }

  private async call<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected')
    const id = ++this.nextId
    const req: JSONRPCRequest = { jsonrpc: '2.0', id, method, params }
    if (this.debug) console.log('[rpc] call', method, params)
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject })
    })
    this.ws.send(JSON.stringify(req))
    return p
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected')
    const msg: any = { jsonrpc: '2.0', method }
    if (params) msg.params = params
    if (this.debug) console.log('[rpc] notify', method, params)
    this.ws.send(JSON.stringify(msg))
  }

  async startSession(sessionId?: string): Promise<{ session_id: string; run_id: string }> {
    const params: Record<string, unknown> = {}
    if (sessionId) params.session_id = sessionId
    return this.call('start_session', params)
  }

  async stopSession(sessionId: string): Promise<boolean> {
    return this.call('stop_session', { session_id: sessionId })
  }

  async sendAudio(sessionId: string, audioBase64: string, commit?: boolean): Promise<boolean> {
    const params: Record<string, unknown> = { session_id: sessionId, audio_base64: audioBase64 }
    if (commit) params.commit = true
    try {
      await this.notify('send_audio', params)
      return true
    } catch {
      return false
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    return this.call('interrupt', { session_id: sessionId })
  }

  async clientResponse(requestId: string, ok: boolean, result?: Record<string, unknown>): Promise<boolean> {
    return this.call('client_response', { request_id: requestId, ok, result })
  }
}
