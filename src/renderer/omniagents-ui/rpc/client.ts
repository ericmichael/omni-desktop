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

export class RPCClient {
  private ws: WebSocket | null = null
  private url: string
  private token?: string
  private nextId = 0
  private pending = new Map<JSONRPCId, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(url: string, token?: string) {
    this.url = url
    this.token = token
  }

  async connect(): Promise<void> {
    const wsUrl = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url
    this.ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('WebSocket init failed'))
      this.ws.onopen = () => resolve()
      this.ws.onerror = (ev) => reject(new Error('WebSocket error'))
    })
    if (!this.ws) throw new Error('WebSocket disconnected')
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as JSONRPCResponse | JSONRPCNotification
        if ('id' in msg) {
          const pending = this.pending.get(msg.id)
          if (pending) {
            this.pending.delete(msg.id)
            if ((msg as JSONRPCResponse).error) {
              pending.reject(new Error((msg as JSONRPCResponse).error!.message))
            } else {
              pending.resolve((msg as JSONRPCResponse).result)
            }
          }
        } else {
          const evt = msg as JSONRPCNotification
          this.emit(evt.method, evt.params)
        }
      } catch (e) {
        console.error('RPC parse error', e)
      }
    }
  }

  disconnect(): void {
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
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject })
    })
    this.ws.send(JSON.stringify(req))
    return p
  }

  // RPC methods
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
