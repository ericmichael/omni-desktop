import { useStore } from '@nanostores/react'
import { AnimatePresence, motion } from 'framer-motion'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { rehydrateHistory } from '@/lib/rehydrate-history'
import { uuidv4 } from '@/lib/uuid'
import { persistedStoreApi } from '@/renderer/services/store'

import type { PendingMessage } from './ChatShell'
import { type ArtifactItem,ArtifactsPanel } from './components/ArtifactsPanel'
import { Header } from './components/Header'
import { Input } from './components/Input'
import { type Attachment, type MessageItem,MessageList } from './components/MessageList'
import { ResizableDivider } from './components/ResizableDivider'
import { type SessionItem,SessionList } from './components/SessionList'
import { Sidebar } from './components/Sidebar'
import { WorkspacePicker } from './components/WorkspacePicker'
import { OmniAgentsHeaderActionsPortal, OmniAgentsHeaderActionsProvider } from './header-actions'
import { useChatSession } from './hooks/use-chat-session'
import { useRPCClient, useRPCConnected } from './rpc-context'
import { useUiConfig } from './ui-config'

type UIState = 'connecting' | 'resume' | 'chat' | 'error'

export type ClientToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }>;

export function App({ sessionId: sessionIdProp, onSessionChange, variables: variablesProp, greeting, onReady, headerActionsTargetId, headerActionsCompact, pendingMessages, sandboxLabel: sandboxLabelProp, onClientToolCall, pendingPlan, onPlanDecision }: { sessionId?: string; onSessionChange?: (sessionId: string | undefined) => void; variables?: Record<string, unknown>; greeting?: string; onReady?: () => void; headerActionsTargetId?: string; headerActionsCompact?: boolean; pendingMessages?: PendingMessage[]; sandboxLabel?: string; onClientToolCall?: ClientToolCallHandler; pendingPlan?: import('@/shared/chat-types').PlanItem | null; onPlanDecision?: (approved: boolean) => void }) {
  const uiConfig = useUiConfig()
  const launcherStore = useStore(persistedStoreApi.$atom)
  const [ui, setUI] = useState<UIState>('connecting')
  const client = useRPCClient()
  const connected = useRPCConnected()
  const [voiceEnabled, setVoiceEnabled] = useState(false)
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
  const urlSessionHandledRef = useRef(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false)
  const [artifactsPanelWidth, setArtifactsPanelWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('artifacts-panel-width')
      return stored ? parseInt(stored, 10) : 240
    } catch {
      return 240
    }
  })
  const [isLargeScreen, setIsLargeScreen] = useState(() => window.innerWidth >= 1024)
  const [minimalMode] = useState(() => uiConfig.minimal)
  const [workspaceSupported, setWorkspaceSupported] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLocked, setWorkspaceLocked] = useState(false)
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false)
  const [initialSessionParam] = useState<string | undefined>(() => uiConfig.session)
  const readyRef = useRef(false)
  const onClientToolCallRef = useRef(onClientToolCall)
  useEffect(() => {
 onClientToolCallRef.current = onClientToolCall
}, [onClientToolCall])
  const onSessionChangeRef = useRef(onSessionChange)
  useEffect(() => {
    onSessionChangeRef.current = onSessionChange
  }, [onSessionChange])
  useEffect(() => {
    readyRef.current = false
  }, [uiConfig.uiUrl])

  // Chat session state machine — manages items, sessionId, runId, thinking,
  // status, preamble, tool status, and approval state.
  const machine = useChatSession(client)
  const {
    actor,
    items, thinking, status, statusSpinner, statusItalic, preamble, toolStatus, runId, sessionId,
    submit, submitError, stop, selectSession, historyLoaded, historyError, newSession, approvalDecided, appendResponse, addArtifact, setSessionId,
  } = machine

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
        if (cancelled) {
return
}
        try {
 await client.clientFunctions(1, [{ name: 'ui.request_tool_approval' }, { name: 'ui.set_status' }, { name: 'ui.add_artifact' }]) 
} catch {}
        if (cancelled) {
return
}
        try {
          const info = await client.getAgentInfo()
          if (cancelled) {
return
}
          const agentName = normalizeAgentName(String(info?.name || 'OmniAgent'))
          setAgentName(agentName)
          const wt = info?.welcome_text ? String(info.welcome_text) : undefined
          setWelcomeText(wt)
          document.title = agentName
        } catch {}
        if (cancelled) {
return
}
        try {
          const funcs = await client.listServerFunctions()
          if (cancelled) {
return
}
          const names = new Set(funcs.map(f => f.name))
          if (names.has('fs_list_dir') && names.has('fs_get_workspace_root')) {
            setWorkspaceSupported(true)
            try {
              const res = await client.serverCall('fs_get_cwd') as any
              if (res?.path && !cancelled) {
setWorkspacePath(res.path)
}
            } catch {}
          }
        } catch {}
        if (cancelled) {
return
}
        try {
          const { RealtimeRPCClient } = await import('./rpc/realtime')
          const rtc = new RealtimeRPCClient(uiConfig.wsRealtimeUrl, uiConfig.token)
          await rtc.connect()
          try {
            const res: any = await rtc.startSession()
            const sid = String(res?.session_id || '')
            if (sid) {
              setVoiceEnabled(true)
              try {
 await rtc.stopSession(sid) 
} catch {}
            }
          } finally {
 rtc.disconnect() 
}
        } catch {
 setVoiceEnabled(false) 
}
        if (cancelled) {
return
}
        const resume = uiConfig.searchParams.get('resume') === 'true'
        const sid = sessionIdProp || uiConfig.searchParams.get('session') || undefined
        if (resume && !sid) {
          try {
            const list = await client.listSessions()
            if (cancelled) {
return
}
            setSessions(list)
            setUI('resume')
          } catch {
            if (!cancelled) {
setUI('chat')
}
          }
        } else {
          if (sid) {
            // Load history for the session so the UI rehydrates past messages
            // on mount (e.g. after browser refresh).
            setSessionId(sid)
            try {
              const history = await client.getSessionHistory(sid)
              if (!cancelled) {
                const msgs = rehydrateHistory(history as Record<string, unknown>[]) as MessageItem[]
                historyLoaded(msgs)
              }
            } catch {}
          }
          setUI('chat')
        }
      })
      .catch(() => {
 if (!cancelled) {
setUI('error')
} 
})

    // Side-effect-only listeners for events the machine doesn't handle
    // (session state + filtering is handled by the useChatSession hook)
    const offRunStarted = client.on('run_started', () => {
      onSessionChangeRef.current?.(actor.getSnapshot().context.sessionId)
      refreshSessions()
    })
    const offRunEnd = client.on('run_end', (p: any) => {
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
      refreshSessions()
    })
    const offToken = client.on('token', (p: any) => {
      try {
        setUsageDelta(p?.delta)
        setUsageTotals(p?.totals)
        setModelInfo({ model: p?.model, max_input_tokens: p?.max_input_tokens, max_output_tokens: p?.max_output_tokens })
      } catch {}
    })
    const offClientRequest = client.on('client_request', (p: any) => {
      const fn = String(p?.function ?? '')
      if (fn === 'ui.add_artifact') {
        const request_id = String(p?.request_id ?? '')
        const args = p?.args || {}
        addArtifact({
          title: typeof args?.title === 'string' ? args.title : '',
          content: typeof args?.content === 'string' ? args.content : '',
          mode: typeof args?.mode === 'string' ? args.mode : 'markdown',
          artifact_id: typeof args?.artifact_id === 'string' ? args.artifact_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        })
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {})
        }
        return
      }
      if (fn === 'tool.call') {
        const request_id = String(p?.request_id ?? '')
        if (!request_id) {
return
}
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

    return () => {
      cancelled = true
      offRunStarted(); offRunEnd(); offClientRequest(); offToken()
      client.disconnect()
    }
  }, [client, actor, setSessionId, historyLoaded, addArtifact, normalizeAgentName, refreshSessions, uiConfig])

  // Derive artifact index from the items stream (artifacts are now inline in conversation)
  const visibleArtifacts = useMemo(() => {
    return items.filter((it): it is ArtifactItem => it.type === 'artifact')
  }, [items])

  useEffect(() => {
    const handler = () => setIsLargeScreen(window.innerWidth >= 1024)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => {
    try {
 localStorage.setItem('artifacts-panel-width', String(artifactsPanelWidth)) 
} catch {}
  }, [artifactsPanelWidth])

  // Scroll to an inline artifact in the conversation stream
  const handleScrollToArtifact = useCallback((artifactId: string) => {
    setArtifactsPanelOpen(false)
    const el = document.querySelector(`[data-artifact-id="${CSS.escape(artifactId)}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-primary', 'rounded-lg')
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'rounded-lg'), 1500)
    }
  }, [])

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
            if (typeof parsed === 'object' && !Array.isArray(parsed)) {
args = parsed
} else if (Array.isArray(parsed)) {
args = { args: parsed }
} else if (typeof parsed === 'string') {
args = { text: parsed }
} else {
args = { value: parsed }
}
          } catch {
            args = { text: argText }
          }
        }
        const result = await client.serverCall(name, args, sessionId)
        const formatted = JSON.stringify(result, null, 2)
        appendResponse(formatted === 'null' ? 'Done.' : formatted)
        return
      } catch (e) {
        appendResponse(`Error: ${String((e as Error)?.message || e)}`)
        return
      }
    }
    try {
      // Ensure we always have a session ID before calling startRun.
      const effectiveSessionId = sessionId ?? uuidv4()
      if (!sessionId) {
        onSessionChangeRef.current?.(effectiveSessionId)
      }
      let content: any | undefined = undefined
      let attachments: Attachment[] = []
      if (files && files.length > 0) {
        const parts: any[] = []
        if (text.trim().length > 0) {
parts.push({ type: 'input_text', text })
}
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
              attachment: { type: 'image' as const, url: dataUrl, filename: f.name, mime: f.type, size: f.size },
            }
          } else {
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => {
                try {
                  const buf = reader.result as ArrayBuffer
                  const bytes = new Uint8Array(buf)
                  let binary = ''
                  for (let i = 0; i < bytes.length; i++) {
binary += String.fromCharCode(bytes[i])
}
                  resolve(btoa(binary))
                } catch {
                  reject(new Error('Failed to encode file'))
                }
              }
              reader.onerror = () => reject(new Error('Failed to read file'))
              reader.readAsArrayBuffer(f)
            })
            const param: any = { type: 'input_file', file_data: base64 }
            if (f.name) {
param.filename = f.name
}
            return {
              filePart: param,
              attachment: { type: 'file' as const, filename: f.name, mime: f.type, size: f.size },
            }
          }
        }))
        parts.push(...processed.map(p => p.filePart))
        attachments = processed.map(p => p.attachment)
        content = parts
      }
      // Tell the machine we're submitting (appends user message, sets sessionId, transitions to starting)
      submit(text, effectiveSessionId, attachments.length ? attachments : undefined)
      // Merge parent-provided variables (e.g. client_tools) with workspace variables
      const workspaceVars = (workspacePath && workspaceSupported)
        ? { workspace_root: workspacePath }
        : undefined
      const variables = (variablesProp || workspaceVars)
        ? { ...variablesProp, ...workspaceVars }
        : undefined
      await client.startRun(text, effectiveSessionId, variables, content)
      if (workspaceSupported) {
setWorkspaceLocked(true)
}
    } catch (e) {
      submitError(String((e as Error)?.message || 'Failed to start run'))
    }
  }, [client, sessionId, variablesProp, submit, submitError, workspacePath, workspaceSupported])

  const handleStop = useCallback(() => {
    if (!runId) {
return
}
    stop()
    client.stopRun(runId).catch(() => {})
  }, [client, stop, runId])

  useEffect(() => {
    if (!connected) {
return
}
    if (ui !== 'chat') {
return
}
    if (initialSent) {
return
}
    // Only send initial message if there's no session param (session param is handled separately)
    const hasSessionParam = uiConfig.searchParams.has('session')
    if (hasSessionParam) {
return
}
    const initial = uiConfig.searchParams.get('initial')
    if (initial && items.length === 0) {
      handleSubmit(initial)
      setInitialSent(true)
    }
  }, [connected, ui, initialSent, items.length, handleSubmit])

  // Flush messages queued from ChatShell before the backend was ready
  const pendingFlushedRef = useRef(false)
  useEffect(() => {
    if (pendingFlushedRef.current) {
return
}
    if (!connected || ui !== 'chat') {
return
}
    if (!pendingMessages || pendingMessages.length === 0) {
return
}
    pendingFlushedRef.current = true
    for (const msg of pendingMessages) {
      handleSubmit(msg.text, msg.files)
    }
  }, [connected, ui, pendingMessages, handleSubmit])

  const handleApprovalDecision = useCallback(async (request_id: string, value: 'yes' | 'always' | 'no') => {
    try {
      const approved = value !== 'no'
      const always_approve = value === 'always'
      await client.clientResponse(request_id, true, { approved, always_approve })
    } catch (e) {
      await client.clientResponse(request_id, false, undefined, { message: String((e as Error)?.message || 'failed') }).catch(() => {})
    }
    approvalDecided(request_id, value)
  }, [client, approvalDecided])

  const handleSelectSession = useCallback(async (id?: string, opts?: { fromProp?: boolean }) => {
    // When no id is provided (new chat), generate a fresh session id so the
    // next startRun creates a brand-new session instead of reusing the last one.
    const resolvedId = id ?? uuidv4()
    // Notify parent of session change (skip if the change originated from the prop)
    if (!opts?.fromProp) {
onSessionChange?.(id === undefined ? resolvedId : id)
}
    if (id) {
      // Resuming an existing session
      selectSession(resolvedId)
      try {
        const history = await client.getSessionHistory(id)
        const msgs = rehydrateHistory(history as Record<string, unknown>[]) as MessageItem[]
        historyLoaded(msgs)
        // Restore workspace from session and lock it
        if (workspaceSupported) {
          try {
            const res = await client.serverCall('fs_get_workspace_root', {}, id) as any
            if (res?.path) {
setWorkspacePath(res.path)
}
          } catch {}
          setWorkspaceLocked(true)
        }
      } catch {
        historyError('Failed to load history')
      }
    } else {
      // New chat
      newSession(resolvedId)
      setWorkspaceLocked(false)
      if (workspaceSupported) {
        try {
          const res = await client.serverCall('fs_get_cwd') as any
          if (res?.path) {
setWorkspacePath(res.path)
}
        } catch {}
      }
    }
    setUI('chat')
  }, [client, selectSession, historyLoaded, historyError, newSession, workspaceSupported, onSessionChange])

  useEffect(() => {
    if (urlSessionHandledRef.current) {
return
}
    if (!initialSessionParam) {
return
}
    if (!connected) {
return
}
    if (ui !== 'chat') {
return
}
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
    if (sessionIdProp === prevSessionIdProp.current) {
return
}
    prevSessionIdProp.current = sessionIdProp
    if (!connected) {
return
}
    const currentSessionId = actor.getSnapshot().context.sessionId
    if (sessionIdProp && sessionIdProp !== currentSessionId) {
      handleSelectSession(sessionIdProp, { fromProp: true })
    } else if (!sessionIdProp && currentSessionId) {
      handleSelectSession(undefined, { fromProp: true })
    }
  }, [sessionIdProp, connected, handleSelectSession, actor])

  useEffect(() => {
    if (!connected) {
return
}
    refreshSessions()
  }, [connected, refreshSessions])

  useEffect(() => {
    if (readyRef.current || !onReady) {
return
}
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
      if (text) {
args.text = text
}
      await client.serverCall(func, args, sessionId)
    } catch {}
  }, [client, sessionId])

  const hasArtifacts = visibleArtifacts.length > 0
  const sandboxLabel = sandboxLabelProp ?? ((launcherStore.sandboxBackend ?? 'none') !== 'none' ? ({ platform: 'Cloud', docker: 'Docker', podman: 'Podman', vm: 'VM', local: 'Local', none: undefined } as Record<string, string | undefined>)[launcherStore.sandboxBackend] : undefined)
  const headerActions = {
    showArtifactsButton: hasArtifacts,
    onArtifactsToggle: hasArtifacts ? () => setArtifactsPanelOpen((v) => !v) : undefined,
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
              showArtifactsButton={headerActions.showArtifactsButton}
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
                  pendingPlan={pendingPlan}
                  onPlanDecision={onPlanDecision}
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
                onVoiceClose={() => {
 const sid = actor.getSnapshot().context.sessionId
 if (sid) {
handleSelectSession(sid);
} refreshSessions();
}}
              />
            </div>
            {isLargeScreen && artifactsPanelOpen && hasArtifacts && (
              <>
                <ResizableDivider
                  onResize={setArtifactsPanelWidth}
                  currentWidth={artifactsPanelWidth}
                  minWidth={180}
                  maxWidth={400}
                />
                <div
                  className="flex-shrink-0 min-h-0 border-l border-bgCardAlt"
                  style={{ width: artifactsPanelWidth }}
                >
                  <ArtifactsPanel
                    artifacts={visibleArtifacts}
                    onClose={() => setArtifactsPanelOpen(false)}
                    onScrollTo={handleScrollToArtifact}
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
            onScrollTo={handleScrollToArtifact}
            asOverlay
          />
        )}
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
