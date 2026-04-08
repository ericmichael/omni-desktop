import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createActor } from 'xstate'
import '@xterm/xterm/css/xterm.css'

import { useRPCClient, useRPCConnected } from '../rpc-context'
import { useUiConfig } from '../ui-config'
import { createMachineLogger } from '@/shared/machines/machine-logger'
import {
  getTerminalConnectionStatus,
  terminalTabMachine,
  type TerminalTabActor,
  type TerminalConnectionStatus,
} from '@/shared/machines/terminal-tab.machine'

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

type TerminalTabMeta = {
  id: string
  label: string
  status: TerminalConnectionStatus
  exitCode?: number
  error?: string
  cwd?: string
}

type TerminalTabRuntime = {
  terminal: Terminal
  fit: FitAddon
  opened: boolean
  socket: WebSocket | null
  actor: TerminalTabActor
  disposables: Array<{ dispose: () => void }>
}

function makeTabId(): string {
  try {
    const value = (globalThis as any)?.crypto?.randomUUID?.()
    if (value) return String(value)
  } catch {}
  return `term_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function TerminalPanel({
  open,
  sessionId,
  onSessionId,
  onClose,
  confined,
}: {
  open: boolean
  sessionId?: string
  onSessionId?: (sid: string) => void
  onClose?: () => void
  confined?: boolean
}) {
  const client = useRPCClient()
  const rpcConnected = useRPCConnected()
  const { token, wsOrigin, resolvePath } = useUiConfig()
  const runtimeRef = useRef(new Map<string, TerminalTabRuntime>())
  const containersRef = useRef(new Map<string, HTMLDivElement>())
  const decoderRef = useRef(new TextDecoder('utf-8', { fatal: false }))
  const encoderRef = useRef(new TextEncoder())
  const tabCountRef = useRef(0)

  const [tabs, setTabs] = useState<TerminalTabMeta[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)

  const authToken = useMemo(() => token, [token])

  // Cleanup all runtimes on unmount
  useEffect(() => {
    return () => {
      const ids = Array.from(runtimeRef.current.keys())
      ids.forEach((id) => {
        const rt = runtimeRef.current.get(id)
        if (!rt) return
        rt.actor.stop()
        try { rt.socket?.close() } catch {}
        rt.disposables.forEach((d) => { try { d.dispose() } catch {} })
        try { rt.terminal.dispose() } catch {}
      })
      runtimeRef.current.clear()
      containersRef.current.clear()
    }
  }, [])

  const ensureSession = useCallback(async (): Promise<string> => {
    const existing = String(sessionId || '').trim()
    if (existing) return existing
    const res: any = await client.serverCall('session.ensure', {})
    const sid = String(res?.session_id || '').trim()
    if (!sid) throw new Error('Session unavailable')
    try { onSessionId?.(sid) } catch {}
    return sid
  }, [client, onSessionId, sessionId])

  const sendFrame = useCallback((tabId: string, payload: any) => {
    const rt = runtimeRef.current.get(tabId)
    if (!rt) return
    const ws = rt.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify(payload)) } catch {}
  }, [])

  const ensureRuntime = useCallback(
    (tabId: string): TerminalTabRuntime => {
      const existing = runtimeRef.current.get(tabId)
      if (existing) return existing

      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: '#0b0f14',
          foreground: '#e5e7eb',
        },
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)

      const actor = createActor(terminalTabMachine, {
        input: { tabId },
        inspect: createMachineLogger('terminal', { tags: { tab: tabId } }),
      })

      const rt: TerminalTabRuntime = {
        terminal,
        fit,
        opened: false,
        socket: null,
        actor,
        disposables: [],
      }

      // Subscribe to machine state changes → update tab meta
      const sub = actor.subscribe((snapshot) => {
        const status = getTerminalConnectionStatus(snapshot.value as string)
        const ctx = snapshot.context
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  status,
                  error: ctx.error ?? undefined,
                  exitCode: ctx.exitCode ?? undefined,
                  cwd: ctx.cwd ?? undefined,
                }
              : t
          )
        )
      })
      rt.disposables.push({ dispose: () => sub.unsubscribe() })

      rt.disposables.push(
        terminal.onData((data) => {
          const bytes = encoderRef.current.encode(data)
          if (!bytes.length) return
          sendFrame(tabId, { type: 'input', data: base64Encode(bytes) })
        })
      )

      rt.disposables.push(
        terminal.onResize(({ cols, rows }) => {
          if (!cols || !rows) return
          sendFrame(tabId, { type: 'resize', cols, rows })
        })
      )

      actor.start()
      runtimeRef.current.set(tabId, rt)
      return rt
    },
    [sendFrame]
  )

  const openInContainer = useCallback(
    (tabId: string) => {
      const rt = ensureRuntime(tabId)
      if (rt.opened) return
      const container = containersRef.current.get(tabId)
      if (!container) return
      try {
        rt.terminal.open(container)
        rt.fit.fit()
        rt.opened = true
      } catch {}
    },
    [ensureRuntime]
  )

  /**
   * Drive the terminal connection lifecycle by reacting to machine state.
   * The machine enforces transitions and timeouts; this function provides
   * the async side effects.
   */
  const connectTab = useCallback(
    async (tabId: string) => {
      const rt = ensureRuntime(tabId)
      const snap = rt.actor.getSnapshot()
      const status = getTerminalConnectionStatus(snap.value as string)

      // Only connect if disconnected
      if (status !== 'disconnected') return

      // Tell machine we're starting
      rt.actor.send({ type: 'CONNECT' })

      try {
        // Step 1: Ensure session
        const sid = await ensureSession()
        rt.actor.send({ type: 'SESSION_OK', sessionId: sid })

        openInContainer(tabId)

        // Step 2: Create terminal via RPC
        const created: any = await client.serverCall(
          'terminal.create',
          { cols: rt.terminal.cols, rows: rt.terminal.rows },
          sid
        )

        const terminalId = String(created?.terminal_id || '').trim()
        const terminalToken = String((created?.terminal_token || created?.token) || '').trim()
        const path = String(created?.path || '/ws/terminal').trim() || '/ws/terminal'
        const resolvedCwd = created?.cwd ? String(created.cwd) : undefined

        if (!terminalId || !terminalToken) {
          rt.actor.send({ type: 'TERMINAL_CREATE_ERROR', error: 'Terminal creation failed — missing ID or token' })
          return
        }

        rt.actor.send({
          type: 'TERMINAL_CREATED',
          terminalId,
          token: terminalToken,
          path,
          cwd: resolvedCwd,
          sessionId: created?.session_id ? String(created.session_id) : undefined,
        })

        // Step 3: Connect WebSocket
        const url = new URL(wsOrigin + resolvePath(path))
        url.searchParams.set('session_id', created?.session_id || sid)
        url.searchParams.set('terminal_id', terminalId)
        url.searchParams.set('terminal_token', terminalToken)
        if (authToken) url.searchParams.set('token', authToken)

        const ws = new WebSocket(url.toString())
        rt.socket = ws

        ws.onopen = () => {
          rt.actor.send({ type: 'WS_OPEN' })
          sendFrame(tabId, {
            type: 'resize',
            cols: rt.terminal.cols,
            rows: rt.terminal.rows,
          })
        }

        ws.onmessage = (ev) => {
          let msg: any = null
          try { msg = JSON.parse(String(ev.data)) } catch { return }
          if (!msg || typeof msg !== 'object') return
          const type = String(msg.type || '')
          if (type === 'output') {
            const data = typeof msg.data === 'string' ? msg.data : ''
            if (!data) return
            try {
              const bytes = base64Decode(data)
              const text = decoderRef.current.decode(bytes)
              rt.terminal.write(text)
            } catch {}
            return
          }
          if (type === 'exit') {
            const code = msg.code
            try {
              rt.terminal.writeln(`\r\n[process exited${code == null ? '' : `: ${code}`}]`)
            } catch {}
            rt.actor.send({ type: 'EXIT', code: typeof code === 'number' ? code : undefined })
            try { rt.socket?.close() } catch {}
            rt.socket = null
            return
          }
        }

        ws.onerror = () => {
          rt.actor.send({ type: 'WS_ERROR', error: 'Terminal connection error' })
          try { rt.socket?.close() } catch {}
          rt.socket = null
        }

        ws.onclose = () => {
          const wasExited = rt.socket === null
          rt.socket = null
          if (!wasExited) {
            rt.actor.send({ type: 'WS_CLOSE' })
          }
        }
      } catch (e: any) {
        // Determine which phase failed and send the appropriate event
        const snap = rt.actor.getSnapshot()
        const state = snap.value as string
        const errorMsg = String(e?.message || e)

        if (state === 'ensuringSession') {
          rt.actor.send({ type: 'SESSION_ERROR', error: errorMsg })
        } else if (state === 'creatingTerminal') {
          rt.actor.send({ type: 'TERMINAL_CREATE_ERROR', error: errorMsg })
        } else if (state === 'connectingWs') {
          rt.actor.send({ type: 'WS_ERROR', error: errorMsg })
        } else {
          // Fallback: if machine is in an unexpected state, try generic error
          rt.actor.send({ type: 'WS_ERROR', error: errorMsg })
        }
      }
    },
    [authToken, client, ensureRuntime, ensureSession, openInContainer, resolvePath, sendFrame, wsOrigin]
  )

  // Use refs for unstable callbacks to prevent the main effect from re-firing
  const connectTabRef = useRef(connectTab)
  useEffect(() => { connectTabRef.current = connectTab }, [connectTab])

  const openInContainerRef = useRef(openInContainer)
  useEffect(() => { openInContainerRef.current = openInContainer }, [openInContainer])

  const addTab = useCallback(() => {
    const id = makeTabId()
    tabCountRef.current += 1
    const label = `Terminal ${tabCountRef.current}`
    setTabs((prev) => [
      ...prev,
      {
        id,
        label,
        status: 'disconnected',
      },
    ])
    setActiveId(id)
  }, [])

  const closeTab = useCallback(
    async (tabId: string) => {
      const rt = runtimeRef.current.get(tabId)
      if (rt) {
        // Notify machine
        rt.actor.send({ type: 'CLOSE' })
        rt.actor.stop()

        try { sendFrame(tabId, { type: 'close' }) } catch {}
        try { rt.socket?.close() } catch {}
        rt.socket = null

        const snap = rt.actor.getSnapshot()
        const ctx = snap.context
        if (ctx.terminalId && ctx.sessionId) {
          try {
            await client.serverCall(
              'terminal.close',
              { terminal_id: ctx.terminalId },
              ctx.sessionId
            )
          } catch {}
        }

        rt.disposables.forEach((d) => { try { d.dispose() } catch {} })
        try { rt.terminal.dispose() } catch {}
        runtimeRef.current.delete(tabId)
        containersRef.current.delete(tabId)
      }

      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId)
        const nextTabs = prev.filter((t) => t.id !== tabId)
        setActiveId((current) => {
          if (current !== tabId) return current
          if (!nextTabs.length) return undefined
          const pick = Math.max(0, idx - 1)
          return nextTabs[pick]?.id || nextTabs[0].id
        })
        return nextTabs
      })
    },
    [client, sendFrame]
  )

  // Auto-create first tab
  useEffect(() => {
    if (!tabs.length) addTab()
  }, [addTab, tabs.length])

  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeId) || (tabs.length ? tabs[0] : undefined)
  }, [activeId, tabs])

  // Main effect: connect active tab when ready.
  // Only attempt connection when the panel is open AND the RPC client is
  // connected — avoids hammering WebSocket connections for invisible terminals
  // while sandboxes are still starting up.
  const activeTabId = activeTab?.id
  useEffect(() => {
    if (!activeTabId || !open || !rpcConnected) return
    setActiveId(activeTabId)
    openInContainerRef.current(activeTabId)
    const rt = runtimeRef.current.get(activeTabId)
    if (rt && rt.opened) {
      try { rt.fit.fit() } catch {}
      sendFrame(activeTabId, {
        type: 'resize',
        cols: rt.terminal.cols,
        rows: rt.terminal.rows,
      })
    }
    connectTabRef.current(activeTabId)
  }, [activeTabId, open, rpcConnected, sendFrame])

  useEffect(() => {
    const onWindowResize = () => {
      if (!open) return
      const id = activeId
      if (!id) return
      const rt = runtimeRef.current.get(id)
      if (!rt || !rt.opened) return
      try { rt.fit.fit() } catch {}
      sendFrame(id, {
        type: 'resize',
        cols: rt.terminal.cols,
        rows: rt.terminal.rows,
      })
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [activeId, open, sendFrame])

  const setContainer = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) containersRef.current.set(tabId, el)
    else containersRef.current.delete(tabId)
  }, [])

  const statusLabel = (tab: TerminalTabMeta) => {
    switch (tab.status) {
      case 'connected': return 'connected'
      case 'connecting': return 'connecting'
      case 'exited': return 'exited'
      case 'error': return 'error'
      case 'closed': return 'closed'
      default: return 'disconnected'
    }
  }

  return (
    <div
      className={[
        confined ? 'absolute inset-0 z-30' : 'fixed inset-0 z-40',
        'transition-opacity',
        open
          ? 'opacity-100 pointer-events-auto'
          : 'opacity-0 pointer-events-none',
      ].join(' ')}
      aria-hidden={open ? undefined : true}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={[
          'absolute left-0 right-0 bottom-0 h-[50vh] sm:h-[70vh] bg-bgColumn border-t border-bgCardAlt flex flex-col transition-transform',
          open ? 'translate-y-0' : 'translate-y-4',
        ].join(' ')}
      >
        <div className="px-4 py-3 border-b border-bgCardAlt flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="text-base font-semibold text-textHeading">Terminal</div>
            {activeTab ? (
              <div className="text-xs text-textSecondary">
                {statusLabel(activeTab)}
              </div>
            ) : null}
            {activeTab?.cwd ? (
              <div className="text-xs text-textSecondary">{activeTab.cwd}</div>
            ) : null}
            {activeTab?.error ? (
              <div className="text-xs text-errorRed">{activeTab.error}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 rounded bg-bgCardAlt hover:bg-bgCardAlt/80 text-textPrimary text-sm"
              onClick={() => addTab()}
            >
              New
            </button>
            <button
              className="w-8 h-8 rounded hover:bg-bgCardAlt text-textPrimary"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="px-4 py-2 border-b border-bgCardAlt flex items-center gap-1 overflow-x-auto flex-shrink-0">
          {tabs.map((t) => {
            const active = t.id === activeId
            return (
              <div
                key={t.id}
                className={[
                  'flex items-center gap-1 px-2 py-1 rounded text-xs whitespace-nowrap border',
                  active
                    ? 'bg-bgCardAlt text-textHeading border-bgCardAlt'
                    : 'bg-transparent text-textSecondary border-bgCardAlt/60 hover:bg-bgCardAlt/40',
                ].join(' ')}
              >
                <button className="text-left" onClick={() => setActiveId(t.id)}>
                  {t.label}
                </button>
                <button
                  className="ml-1 text-textSecondary hover:text-textHeading"
                  aria-label="Close tab"
                  onClick={() => closeTab(t.id)}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex-1 overflow-hidden">
          {tabs.map((t) => (
            <div
              key={t.id}
              ref={(el) => setContainer(t.id, el)}
              className={t.id === activeId ? 'h-full w-full' : 'hidden'}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
