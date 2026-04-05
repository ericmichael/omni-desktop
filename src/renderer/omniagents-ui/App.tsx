import { useStore } from '@nanostores/react'
import { AnimatePresence, motion } from 'framer-motion'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Header } from './components/Header'
import { MessageList, type MessageItem } from './components/MessageList'
import { Input } from './components/Input'
import { SessionList, type SessionItem } from './components/SessionList'
import { Sidebar } from './components/Sidebar'
import { ArtifactsPanel, type ArtifactItem } from './components/ArtifactsPanel'
import { ResizableDivider } from './components/ResizableDivider'
import { TerminalPanel } from './components/TerminalPanel'
import { WorkspacePicker } from './components/WorkspacePicker'
import type { PendingMessage } from './ChatShell'
import { useRPCClient, useRPCConnected } from './rpc-context'
import { useUiConfig } from './ui-config'
import { OmniAgentsHeaderActionsPortal, OmniAgentsHeaderActionsProvider } from './header-actions'
import { uuidv4 } from '@/lib/uuid'
import { persistedStoreApi } from '@/renderer/services/store'

type UIState = 'connecting' | 'resume' | 'chat' | 'error'

export type ClientToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }>;

export function App({ sessionId: sessionIdProp, onSessionChange, variables: variablesProp, greeting, onReady, headerActionsTargetId, headerActionsCompact, pendingMessages, sandboxLabel: sandboxLabelProp, onClientToolCall }: { sessionId?: string; onSessionChange?: (sessionId: string | undefined) => void; variables?: Record<string, unknown>; greeting?: string; onReady?: () => void; headerActionsTargetId?: string; headerActionsCompact?: boolean; pendingMessages?: PendingMessage[]; sandboxLabel?: string; onClientToolCall?: ClientToolCallHandler }) {
  const uiConfig = useUiConfig()
  const launcherStore = useStore(persistedStoreApi.$atom)
  const [ui, setUI] = useState<UIState>('connecting')
  const client = useRPCClient()
  const connected = useRPCConnected()
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [items, setItems] = useState<MessageItem[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([])
  const [thinking, setThinking] = useState(false)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [statusSpinner, setStatusSpinner] = useState<boolean>(false)
  const [statusItalic, setStatusItalic] = useState<boolean>(false)
  const [preamble, setPreamble] = useState<string | undefined>(undefined)
  const [toolStatus, setToolStatus] = useState<string | undefined>(undefined)
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [_usageTotals, setUsageTotals] = useState<any | undefined>(undefined)
  const [_usageDelta, setUsageDelta] = useState<any | undefined>(undefined)
  const [_modelInfo, setModelInfo] = useState<{ model?: string; max_input_tokens?: number; max_output_tokens?: number } | undefined>(undefined)
  const [agentName, setAgentName] = useState<string>('OmniAgent')
  const [welcomeText, setWelcomeText] = useState<string | undefined>(undefined)
  const normalizeAgentName = useCallback((name: string) => {
    let s = String(name || '').trim()
    s = s.replace(/[_-]+/g, ' ')
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    s = s.replace(/\s+/g, ' ')
    return s.split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : '').join(' ').trim()
  }, [])

  const [initialSent, setInitialSent] = useState(false)
  const preambleBufferRef = useRef<Array<{ content: string; timestamp: Date; superseded: boolean }>>([])
  const pendingApprovalsRef = useRef(new Map<string, (MessageItem & { session_id?: string })>())
  const urlSessionHandledRef = useRef(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false)
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false)
  const [artifactsPanelWidth, setArtifactsPanelWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('artifacts-panel-width')
      return stored ? parseInt(stored, 10) : 480
    } catch {
      return 480
    }
  })
  const [isLargeScreen, setIsLargeScreen] = useState(() => window.innerWidth >= 1024)
  const [minimalMode] = useState(() => uiConfig.minimal)
  const [workspaceSupported, setWorkspaceSupported] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLocked, setWorkspaceLocked] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [initialSessionParam] = useState<string | undefined>(() => uiConfig.session)
  const sessionIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  const runIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    runIdRef.current = runId
  }, [runId])
  const startingRunRef = useRef(false)
  const readyRef = useRef(false)
  const onClientToolCallRef = useRef(onClientToolCall)
  useEffect(() => { onClientToolCallRef.current = onClientToolCall }, [onClientToolCall])
  useEffect(() => {
    readyRef.current = false
  }, [uiConfig.uiUrl])
  const appendPendingApprovals = useCallback((base: MessageItem[], targetSession?: string) => {
    if (!targetSession) return base
    const additions: MessageItem[] = []
    for (const item of pendingApprovalsRef.current.values()) {
      const itemSession = (item as any).session_id
      if (itemSession && itemSession !== targetSession) continue
      const exists = base.some(existing => existing.type === 'approval' && (existing as any).request_id === (item as any).request_id)
      if (!exists) additions.push(item)
    }
    return additions.length ? [...base, ...additions] : base
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const list = await client.listSessions()
      setSessions(list)
    } catch {}
  }, [client])

  useEffect(() => {
      let cancelled = false

      client.connectAndWait()
        .then(async () => {
        if (cancelled) return
        try { await client.clientFunctions(1, [{ name: 'ui.request_tool_approval' }, { name: 'ui.set_status' }, { name: 'ui.add_artifact' }]) } catch {}
        if (cancelled) return
        try {
          const info = await client.getAgentInfo()
          if (cancelled) return
          const agentName = normalizeAgentName(String(info?.name || 'OmniAgent'))
          setAgentName(agentName)
          const wt = info?.welcome_text ? String(info.welcome_text) : undefined
          setWelcomeText(wt)
          document.title = agentName
        } catch {}
        if (cancelled) return
        try {
          const funcs = await client.listServerFunctions()
          if (cancelled) return
          const names = new Set(funcs.map(f => f.name))
          if (names.has('fs_list_dir') && names.has('fs_get_workspace_root')) {
            setWorkspaceSupported(true)
            try {
              const res = await client.serverCall('fs_get_cwd') as any
              if (res?.path && !cancelled) setWorkspacePath(res.path)
            } catch {}
          }
        } catch {}
        if (cancelled) return
        try {
          const { RealtimeRPCClient } = await import('./rpc/realtime')
          const rtc = new RealtimeRPCClient(uiConfig.wsRealtimeUrl, uiConfig.token)
          await rtc.connect()
          try {
            const res: any = await rtc.startSession()
            const sid = String(res?.session_id || '')
            if (sid) {
              setVoiceEnabled(true)
              try { await rtc.stopSession(sid) } catch {}
            }
          } finally { rtc.disconnect() }
        } catch { setVoiceEnabled(false) }
        if (cancelled) return
        const resume = uiConfig.searchParams.get('resume') === 'true'
        const sid = sessionIdProp || uiConfig.searchParams.get('session') || undefined
        if (resume && !sid) {
          try {
            const list = await client.listSessions()
            if (cancelled) return
            setSessions(list)
            setUI('resume')
          } catch {
            if (!cancelled) setUI('chat')
          }
        } else {
          if (sid) setSessionId(sid)
          setUI('chat')
        }
      })
      .catch(() => { if (!cancelled) setUI('error') })

    const offMessageOutput = client.on('message_output', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId) {
        if (sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
        if (!sessionIdRef.current && !startingRunRef.current) return
      }
      const content = String(p?.content ?? '')
      if (!content) return
      preambleBufferRef.current.push({ content, timestamp: new Date(), superseded: false })
      setPreamble(content)
      setStatus(undefined)
      setStatusItalic(false)
    })
    const offRunStarted = client.on('run_started', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId) {
        if (sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
        if (!sessionIdRef.current && !startingRunRef.current) return
      }
      startingRunRef.current = false
      setRunId(String(p?.run_id ?? ''))
      if (eventSessionId) setSessionId(eventSessionId)
      setThinking(true)
      preambleBufferRef.current = []
      setPreamble(undefined)
      setStatus(undefined)
      setToolStatus(undefined)
      setStatusSpinner(false)
      setStatusItalic(false)
      refreshSessions()
    })
    const offRunEnd = client.on('run_end', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId && sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
      setThinking(false)
      const nonSuperseded = preambleBufferRef.current.filter(m => !m.superseded)
      if (nonSuperseded.length) {
        setItems(prev => [
          ...prev,
          ...nonSuperseded.map(m => ({ type: 'chat', role: 'assistant', content: m.content } as MessageItem)),
        ])
      }
      preambleBufferRef.current = []
      setPreamble(undefined)
      setToolStatus(undefined)
      try {
        const usage = p?.usage || {}
        const info = {
          model: p?.model,
          max_input_tokens: p?.max_input_tokens,
          max_output_tokens: p?.max_output_tokens,
        }
        setModelInfo(info)
        setUsageTotals(usage)
      } catch {}
      setStatusSpinner(false)
      setStatusItalic(false)
      refreshSessions()
    })
    const offRunStatus = client.on('run_status', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId && sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
      const msg = [p?.status, p?.message].filter(Boolean).join(': ')
      setStatus(msg)
      setStatusSpinner(true)
      setStatusItalic(false)
    })
    const offToken = client.on('token', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId && sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
      try {
        setUsageDelta(p?.delta)
        setUsageTotals(p?.totals)
        setModelInfo({ model: p?.model, max_input_tokens: p?.max_input_tokens, max_output_tokens: p?.max_output_tokens })
      } catch {}
    })
    const offToolCalled = client.on('tool_called', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId) {
        if (sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
        if (!sessionIdRef.current && !startingRunRef.current) return
      }
      const tool = String(p?.tool ?? '')
      const input = typeof p?.input === 'string' ? p?.input : JSON.stringify(p?.input)
      const call_id = String(p?.call_id ?? '')
      preambleBufferRef.current.forEach(m => { m.superseded = true })
      setItems(prev => [...prev, { type: 'tool', tool, input, call_id, status: 'called', runId: runIdRef.current }])
    })
    const offToolResult = client.on('tool_result', (p: any) => {
      const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
      if (eventSessionId) {
        if (sessionIdRef.current && sessionIdRef.current !== eventSessionId) return
        if (!sessionIdRef.current && !startingRunRef.current) return
      }
      const tool = String(p?.tool ?? '')
      const output = typeof p?.output === 'string' ? p?.output : JSON.stringify(p?.output)
      const call_id = String(p?.call_id ?? '')
      const metadata = p?.metadata
      preambleBufferRef.current.forEach(m => { m.superseded = true })
      setItems(prev => {
        const idx = prev.findIndex(it => it.type === 'tool' && (it as any).call_id === call_id)
        if (idx >= 0) {
          const next = prev.slice()
          const it = next[idx] as any
          next[idx] = { ...it, output, status: 'result', metadata }
          return next
        }
        return [...prev, { type: 'tool', tool, output, call_id, status: 'result', metadata, runId: runIdRef.current }]
      })
    })
    const offClientRequest = client.on('client_request', (p: any) => {
      const fn = String(p?.function ?? '')
      if (fn === 'ui.add_artifact') {
        const request_id = String(p?.request_id ?? '')
        const args = p?.args || {}
        const title = typeof args?.title === 'string' ? args.title : ''
        const content = typeof args?.content === 'string' ? args.content : ''
        const mode = typeof args?.mode === 'string' ? args.mode : 'markdown'
        const artifact_id = typeof args?.artifact_id === 'string' ? args.artifact_id : undefined
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
        const updated_at = Date.now()
        setArtifacts(prev => {
          const next = prev.slice()
          const idx = artifact_id ? next.findIndex(a => a.artifact_id === artifact_id && (!eventSessionId || a.session_id === eventSessionId)) : -1
          const entry: ArtifactItem = { title, content, mode, artifact_id, session_id: eventSessionId, updated_at }
          if (idx >= 0) next[idx] = entry
          else next.push(entry)
          return next
        })
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {})
        }
        return
      }
      if (fn === 'ui.request_tool_approval') {
        const args = p?.args || {}
        const request_id = String(p?.request_id ?? '')
        const tool = String(args?.tool ?? '')
        const argumentsText = String(args?.arguments ?? '')
        const metadata = args?.metadata
        setThinking(false)
        if (!request_id) {
          return
        }
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
        const approvalItem: MessageItem & { session_id?: string } = { type: 'approval', request_id, tool, argumentsText, metadata, session_id: eventSessionId }
        pendingApprovalsRef.current.set(request_id, approvalItem)
        const shouldDisplay = !eventSessionId || !sessionIdRef.current || sessionIdRef.current === eventSessionId
        if (shouldDisplay) {
          setItems(prev => {
            const filtered = prev.filter(it => !(it.type === 'approval' && (it as any).request_id === request_id))
            return [...filtered, approvalItem]
          })
        }
        return
      }
      if (fn === 'ui.set_status') {
        const request_id = String(p?.request_id ?? '')
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined
        if (eventSessionId && sessionIdRef.current && sessionIdRef.current !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {})
          }
          return
        }
        const args = p?.args || {}
        const text = typeof args?.text === 'string' ? args.text : undefined
        const showSpinner = typeof args?.show_spinner === 'boolean' ? !!args.show_spinner : true
        setStatus(text)
        setStatusSpinner(showSpinner)
        setStatusItalic(false)
        if (text && text.trim()) setToolStatus(text)
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {})
        }
        return
      }
      if (fn === 'tool.call') {
        const request_id = String(p?.request_id ?? '')
        if (!request_id) return
        const args = (p?.args || {}) as Record<string, unknown>
        const toolName = String(args.tool ?? '')
        const toolArgs = (args.arguments ?? {}) as Record<string, unknown>
        if (!onClientToolCallRef.current) {
          client.clientResponse(request_id, false, undefined, { message: 'No client tool handler registered' }).catch(() => {})
          return
        }
        onClientToolCallRef.current(toolName, toolArgs)
          .then((res) => {
            client.clientResponse(request_id, res.ok, res.result, res.error).catch(() => {})
          })
          .catch((err: Error) => {
            client.clientResponse(request_id, false, undefined, { message: err.message }).catch(() => {})
          })
        return
      }
    })

    const offClientRequestResolved = client.on('client_request_resolved', (p: any) => {
      const request_id = String(p?.request_id ?? '')
      if (request_id) {
        pendingApprovalsRef.current.delete(request_id)
        setItems(prev => prev.filter(it => !(it.type === 'approval' && (it as any).request_id === request_id)))
      }
    })

    return () => {
      cancelled = true
      offMessageOutput(); offRunStarted(); offRunEnd(); offRunStatus(); offClientRequest(); offClientRequestResolved(); offToken(); offToolCalled(); offToolResult()
      client.disconnect()
    }
  }, [client, normalizeAgentName, refreshSessions, uiConfig])

  const visibleArtifacts = useMemo(() => {
    if (!sessionId) return artifacts.filter(a => !a.session_id)
    return artifacts.filter(a => !a.session_id || a.session_id === sessionId)
  }, [artifacts, sessionId])

  useEffect(() => {
    const handler = () => setIsLargeScreen(window.innerWidth >= 1024)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => {
    try { localStorage.setItem('artifacts-panel-width', String(artifactsPanelWidth)) } catch {}
  }, [artifactsPanelWidth])

  useEffect(() => {
    if (visibleArtifacts.length > 0 && !artifactsPanelOpen) {
      setArtifactsPanelOpen(true)
    }
  }, [visibleArtifacts.length])

  // moved below handleSubmit

  const handleSubmit = useCallback(async (text: string, files?: File[]) => {
    // Slash commands
    if (text.startsWith('/')) {
      const parts = text.trim().split(/\s+/)
      const name = parts[0].slice(1)
      const argText = text.slice(parts[0].length).trim()
      try {
        const funcs = await client.listServerFunctions()
        const found = funcs.find(f => String(f.name).toLowerCase() === name.toLowerCase())
        if (!found) {
          // Not a known server function; send to LLM
          await client.startRun(text, sessionId)
          return
        }
        let args: Record<string, unknown> = {}
        if (argText) {
          try {
            const parsed = JSON.parse(argText)
            if (typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
            else if (Array.isArray(parsed)) args = { args: parsed }
            else if (typeof parsed === 'string') args = { text: parsed }
            else args = { value: parsed }
          } catch {
            args = { text: argText }
          }
        }
        const result = await client.serverCall(name, args, sessionId)
        const formatted = JSON.stringify(result, null, 2)
        setItems(prev => [...prev, { type: 'chat', role: 'assistant', content: formatted === 'null' ? 'Done.' : formatted }])
        return
      } catch (e) {
        setItems(prev => [...prev, { type: 'chat', role: 'assistant', content: `Error: ${String((e as Error)?.message || e)}` }])
        return
      }
    }
    try {
      startingRunRef.current = true
      let content: any | undefined = undefined
      let attachments: Array<{ type: 'image' | 'file'; url?: string; filename?: string; mime?: string; size?: number }> = []
      if (files && files.length > 0) {
        const parts: any[] = []
        if (text.trim().length > 0) parts.push({ type: 'input_text', text })
        const processed = await Promise.all(files.map(async (f) => {
          if (f.type && f.type.startsWith('image/')) {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result || ''))
              reader.onerror = () => reject(new Error('Failed to read image'))
              reader.readAsDataURL(f)
            })
            return {
              filePart: { type: 'input_image', image_url: dataUrl, detail: 'auto' },
              attachment: { type: 'image', url: dataUrl, filename: f.name, mime: f.type, size: f.size },
            }
          } else {
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => {
                try {
                  const buf = reader.result as ArrayBuffer
                  const bytes = new Uint8Array(buf)
                  let binary = ''
                  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
                  resolve(btoa(binary))
                } catch {
                  reject(new Error('Failed to encode file'))
                }
              }
              reader.onerror = () => reject(new Error('Failed to read file'))
              reader.readAsArrayBuffer(f)
            })
            const param: any = { type: 'input_file', file_data: base64 }
            if (f.name) param.filename = f.name
            return {
              filePart: param,
              attachment: { type: 'file', filename: f.name, mime: f.type, size: f.size },
            }
          }
        }))
        parts.push(...processed.map(p => p.filePart))
        attachments = processed.map(p => p.attachment)
        content = parts
      }
      setItems(prev => [...prev, { type: 'chat', role: 'user', content: text, attachments }])
      // Merge parent-provided variables (e.g. client_tools) with workspace variables
      const workspaceVars = (workspacePath && workspaceSupported)
        ? { workspace_root: workspacePath }
        : undefined
      const variables = (variablesProp || workspaceVars)
        ? { ...variablesProp, ...workspaceVars }
        : undefined
      await client.startRun(text, sessionId, variables, content)
      if (workspaceSupported) setWorkspaceLocked(true)
    } catch (e) {
      startingRunRef.current = false
      setStatus(String((e as Error)?.message || 'Failed to start run'))
      setStatusItalic(false)
    }
  }, [client, sessionId, workspacePath, workspaceSupported])

  const handleStop = useCallback(() => {
    if (!runId) return
    try {
      preambleBufferRef.current.forEach(m => { m.superseded = true })
    } catch {}
    setThinking(false)
    setStatusSpinner(false)
    setStatusItalic(true)
    setStatus('Cancelled by user')
    setPreamble(undefined)
    client.stopRun(runId).catch(() => {})
  }, [client, runId])

  useEffect(() => {
    if (!connected) return
    if (ui !== 'chat') return
    if (initialSent) return
    // Only send initial message if there's no session param (session param is handled separately)
    const hasSessionParam = uiConfig.searchParams.has('session')
    if (hasSessionParam) return
    const initial = uiConfig.searchParams.get('initial')
    if (initial && items.length === 0) {
      handleSubmit(initial)
      setInitialSent(true)
    }
  }, [connected, ui, initialSent, items.length, handleSubmit])

  // Flush messages queued from ChatShell before the backend was ready
  const pendingFlushedRef = useRef(false)
  useEffect(() => {
    if (pendingFlushedRef.current) return
    if (!connected || ui !== 'chat') return
    if (!pendingMessages || pendingMessages.length === 0) return
    pendingFlushedRef.current = true
    for (const msg of pendingMessages) {
      handleSubmit(msg.text, msg.files)
    }
  }, [connected, ui, pendingMessages, handleSubmit])

  const handleApprovalDecision = useCallback(async (request_id: string, value: 'yes' | 'always' | 'no') => {
    const removeApproval = () => {
      pendingApprovalsRef.current.delete(request_id)
      setItems(prev => prev.filter(it => !(it.type === 'approval' && (it as any).request_id === request_id)))
    }
    try {
      const approved = value !== 'no'
      const always_approve = value === 'always'
      await client.clientResponse(request_id, true, { approved, always_approve })
      removeApproval()
      setThinking(true)
    } catch (e) {
      await client.clientResponse(request_id, false, undefined, { message: String((e as Error)?.message || 'failed') })
      removeApproval()
      setThinking(true)
    }
  }, [client])

  const handleSelectSession = useCallback(async (id?: string, opts?: { fromProp?: boolean }) => {
    // When no id is provided (new chat), generate a fresh session id so the
    // next startRun creates a brand-new session instead of reusing the last one.
    const resolvedId = id ?? uuidv4()
    setSessionId(resolvedId)
    // Notify parent of session change (skip if the change originated from the prop)
    if (!opts?.fromProp) onSessionChange?.(id === undefined ? resolvedId : id)
    setItems([])
    setPreamble(undefined)
    preambleBufferRef.current = []
    // Reset UI state to prevent stale state from previous conversation
    setThinking(false)
    setStatus(undefined)
    setStatusSpinner(false)
    setStatusItalic(false)
    setRunId(undefined)
    // Reset or restore workspace state
    if (!id) {
      // New chat — unlock workspace, restore default (cwd)
      setWorkspaceLocked(false)
      if (workspaceSupported) {
        try {
          const res = await client.serverCall('fs_get_cwd') as any
          if (res?.path) setWorkspacePath(res.path)
        } catch {}
      }
    }
    if (id) {
      try {
        const history = await client.getSessionHistory(id)
        const msgs: MessageItem[] = []
        const callIndex: Record<string, number> = {}
        for (const item of history as any[]) {
          const t = String((item && item.type) || '')

          if (t && t.endsWith('_call') && !t.endsWith('_call_output')) {
            const tool = String(item.name || '')
            let input = ''
            try {
              if (typeof item.arguments === 'string') input = item.arguments
              else if (item.arguments != null) input = JSON.stringify(item.arguments)
            } catch { input = String(item.arguments || '') }
            const call_id = String(item.call_id || '')
            const idx = msgs.length
            msgs.push({ type: 'tool', tool, input, call_id, status: 'called' })
            if (call_id) callIndex[call_id] = idx
            continue
          }

          if (t && t.endsWith('_call_output')) {
            const call_id = String(item.call_id || '')
            const tool = String(item.name || '')
            let output = ''
            try { output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output) }
            catch { output = String(item.output || '') }
            const metadata = item.metadata
            const existing = (call_id && callIndex[call_id] != null) ? callIndex[call_id] : -1
            if (existing >= 0) {
              const prev = msgs[existing] as any
              msgs[existing] = { ...prev, output, status: 'result', metadata }
            } else {
              msgs.push({ type: 'tool', tool, output, call_id, status: 'result', metadata })
            }
            continue
          }

          if (item && item.role) {
            const role = String(item.role) as any
            let content = ''
            let attachments: Array<{ type: 'image' | 'file'; url?: string; filename?: string; mime?: string; size?: number }> = []

            if (typeof item.content === 'string') {
              content = item.content
            } else if (Array.isArray(item.content)) {
              const parts = item.content as any[]
              if (role === 'assistant') {
                const textParts = parts
                  .filter(p => p && (p.type === 'output_text' || p.type === 'text'))
                  .map(p => String(p.text || ''))
                content = textParts.join('\n')
              } else {
                const textParts = parts
                  .filter(p => p && (p.type === 'input_text' || p.type === 'text'))
                  .map(p => String(p.text || p.input_text || ''))
                content = textParts.join('\n')
                for (const p of parts) {
                  if (p && p.type === 'input_image' && p.image_url) {
                    attachments.push({ type: 'image', url: String(p.image_url), filename: p.filename })
                  } else if (p && p.type === 'input_file') {
                    attachments.push({ type: 'file', filename: p.filename })
                  }
                }
              }
            } else if (item.content && typeof item.content === 'object') {
              const obj = item.content as any
              content = String(obj.text || obj.input_text || '')
              if (!content) {
                try { content = JSON.stringify(item.content) } catch { content = String(item.content) }
              }
            }

            msgs.push({ type: 'chat', role, content, timestamp: item.timestamp, attachments })
            continue
          }
        }
        const merged = appendPendingApprovals(msgs, id)
        setItems(merged)
        // Restore workspace from session and lock it
        if (workspaceSupported) {
          try {
            const res = await client.serverCall('fs_get_workspace_root', {}, id) as any
            if (res?.path) setWorkspacePath(res.path)
          } catch {}
          setWorkspaceLocked(true)
        }
      } catch {}
    } else {
      setItems([])
    }
    setUI('chat')
  }, [client, appendPendingApprovals, workspaceSupported, onSessionChange])

  useEffect(() => {
    if (urlSessionHandledRef.current) return
    if (!initialSessionParam) return
    if (!connected) return
    if (ui !== 'chat') return
    urlSessionHandledRef.current = true
    // Load session history, then send initial message only if session is empty
    ;(async () => {
      await handleSelectSession(initialSessionParam)
      const initial = uiConfig.searchParams.get('initial')
      if (initial && !initialSent) {
        // Check if session has history - if items is still empty after handleSelectSession, it's a new session
        // We need to check the actual history since handleSelectSession sets items
        try {
          const history = await client.getSessionHistory(initialSessionParam)
          if (history.length === 0) {
            handleSubmit(initial)
            setInitialSent(true)
          }
        } catch {
          // If we can't get history, assume it's new and send initial
          handleSubmit(initial)
          setInitialSent(true)
        }
      }
    })()
  }, [connected, ui, handleSelectSession, initialSessionParam, client, initialSent, handleSubmit])

  // React to controlled sessionId prop changes from parent
  const prevSessionIdProp = useRef(sessionIdProp)
  useEffect(() => {
    if (sessionIdProp === prevSessionIdProp.current) return
    prevSessionIdProp.current = sessionIdProp
    if (!connected) return
    if (sessionIdProp && sessionIdProp !== sessionIdRef.current) {
      handleSelectSession(sessionIdProp, { fromProp: true })
    } else if (!sessionIdProp && sessionIdRef.current) {
      handleSelectSession(undefined, { fromProp: true })
    }
  }, [sessionIdProp, connected, handleSelectSession])

  useEffect(() => {
    if (!connected) return
    refreshSessions()
  }, [connected, refreshSessions])

  useEffect(() => {
    if (readyRef.current || !onReady) return
    if (connected && (ui === 'chat' || ui === 'resume')) {
      readyRef.current = true
      onReady()
    }
  }, [connected, onReady, ui])

  const onNewChat = useCallback(() => {
    handleSelectSession(undefined)
  }, [handleSelectSession])

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await client.deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (sessionId === id) {
        handleSelectSession(undefined)
      }
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }, [client, sessionId, handleSelectSession])

  const handleReaction = useCallback(async (type: 'like' | 'dislike', text?: string) => {
    try {
      const func = type === 'like' ? 'good' : 'bad'
      const args: Record<string, unknown> = {}
      if (text) args.text = text
      await client.serverCall(func, args, sessionId)
    } catch {}
  }, [client, sessionId])

  const hasArtifacts = visibleArtifacts.length > 0
  const sandboxLabel = sandboxLabelProp ?? (launcherStore.sandboxEnabled ? (launcherStore.sandboxVariant === 'standard' ? 'Standard' : 'Work') : undefined)
  const headerActions = {
    showArtifactsButton: hasArtifacts,
    showTerminalButton: true,
    onArtifactsToggle: hasArtifacts ? () => setArtifactsPanelOpen((v) => !v) : undefined,
    onTerminalToggle: () => setTerminalPanelOpen((v) => !v),
  }

  let content: React.ReactNode = null
  if (ui === 'resume') {
    content = (
      <div className="app flex-col">
        <Header agentName={agentName} />
        <div className="container-chat">
          <SessionList sessions={sessions} onSelect={handleSelectSession} />
        </div>
      </div>
    )
  } else {
    content = (
      <div className="app h-full flex flex-row min-w-0 relative">
        {!minimalMode && (
          <Sidebar
            open={sidebarOpen}
            sessions={sessions}
            selectedId={sessionId}
            onClose={() => setSidebarOpen(false)}
            onNewChat={onNewChat}
            onSelect={(id) => handleSelectSession(id)}
            onDelete={handleDeleteSession}
          />
        )}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {!minimalMode && (
            <Header
              agentName={agentName}
              onMenu={() => setSidebarOpen(v => !v)}
              onArtifactsToggle={headerActions.onArtifactsToggle}
              onTerminalToggle={headerActions.onTerminalToggle}
              showArtifactsButton={headerActions.showArtifactsButton}
              showTerminalButton={headerActions.showTerminalButton}
            />
          )}
          <div className="flex-1 flex flex-row min-h-0 min-w-0">
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <div className="flex-1 min-h-0 relative flex flex-col">
                <MessageList
                  items={items}
                  greeting={greeting}
                  statusText={status}
                  thinking={thinking}
                  statusSpinner={statusSpinner}
                  preambleText={preamble}
                  welcomeText={welcomeText}
                  onApprovalDecision={handleApprovalDecision}
                  statusItalic={statusItalic}
                  onReaction={handleReaction}
                  currentRunId={runId}
                  toolStatusText={toolStatus}
                />
                <AnimatePresence>
                  {!connected && (
                    <motion.div
                      className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none z-10"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                    >
                      <div className="inline-flex items-center gap-1.5 rounded-full bg-bgCardAlt px-3 py-1">
                        <svg className="animate-spin h-3 w-3 text-textSubtle" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span className="text-xs text-textSubtle">Connecting…</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <Input
                disabled={!connected}
                thinking={thinking}
                onStop={handleStop}
                onSubmit={handleSubmit}
                voiceEnabled={voiceEnabled}
                workspacePath={workspaceSupported ? workspacePath : undefined}
                workspaceLocked={workspaceLocked}
                onWorkspaceClick={() => setWorkspacePickerOpen(true)}
                sandboxLabel={sandboxLabel}
                sandboxLoading={!connected}
                sessionId={sessionId}
                onVoiceSessionCreated={(id: string) => setSessionId(id)}
                onVoiceClose={() => { if (sessionIdRef.current) handleSelectSession(sessionIdRef.current); refreshSessions(); }}
              />
            </div>
            {isLargeScreen && artifactsPanelOpen && hasArtifacts && (
              <>
                <ResizableDivider
                  onResize={setArtifactsPanelWidth}
                  currentWidth={artifactsPanelWidth}
                  minWidth={320}
                  maxWidth={800}
                />
                <div
                  className="flex-shrink-0 min-h-0 border-l border-bgCardAlt"
                  style={{ width: artifactsPanelWidth }}
                >
                  <ArtifactsPanel
                    artifacts={visibleArtifacts}
                    onClose={() => setArtifactsPanelOpen(false)}
                  />
                </div>
              </>
            )}
          </div>
        </div>
        {!isLargeScreen && artifactsPanelOpen && hasArtifacts && (
          <ArtifactsPanel
            artifacts={visibleArtifacts}
            onClose={() => setArtifactsPanelOpen(false)}
            asOverlay
          />
        )}
        <TerminalPanel
          open={terminalPanelOpen}
          sessionId={sessionId}
          onSessionId={setSessionId}
          onClose={() => setTerminalPanelOpen(false)}
          confined={minimalMode}
        />
        {workspacePickerOpen && (
          <WorkspacePicker
            sessionId={sessionId}
            initialPath={workspacePath || undefined}
            onSelect={(path) => {
              setWorkspacePath(path)
              setWorkspacePickerOpen(false)
            }}
            onClose={() => setWorkspacePickerOpen(false)}
          />
        )}
      </div>
    )
  }

  return (
    <OmniAgentsHeaderActionsProvider {...headerActions}>
      {content}
      {headerActionsTargetId ? <OmniAgentsHeaderActionsPortal targetId={headerActionsTargetId} compact={headerActionsCompact} /> : null}
    </OmniAgentsHeaderActionsProvider>
  )
}
