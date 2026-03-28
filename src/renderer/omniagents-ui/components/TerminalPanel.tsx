import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import { RPCClient } from '../rpc/client'
import { useUiConfig } from '../ui-config'

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

type TerminalState = {
  sessionId: string
  terminalId: string
  terminalToken: string
  path: string
  cwd?: string
}

type TerminalTabMeta = {
  id: string
  label: string
  connecting: boolean
  connected: boolean
  exited: boolean
  exitCode?: number
  error?: string
  cwd?: string
}

type TerminalTabRuntime = {
  terminal: Terminal
  fit: FitAddon
  opened: boolean
  socket: WebSocket | null
  state: TerminalState | null
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
  client,
  sessionId,
  onSessionId,
  onClose,
  confined,
}: {
  open: boolean
  client: RPCClient
  sessionId?: string
  onSessionId?: (sid: string) => void
  onClose?: () => void
  confined?: boolean
}) {
  const { token, wsOrigin, resolvePath } = useUiConfig()
  const runtimeRef = useRef(new Map<string, TerminalTabRuntime>())
  const containersRef = useRef(new Map<string, HTMLDivElement>())
  const decoderRef = useRef(new TextDecoder('utf-8', { fatal: false }))
  const encoderRef = useRef(new TextEncoder())
  const tabCountRef = useRef(0)

  const [tabs, setTabs] = useState<TerminalTabMeta[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)

  const authToken = useMemo(() => token, [token])

  useEffect(() => {
    return () => {
      const ids = Array.from(runtimeRef.current.keys())
      ids.forEach((id) => {
        const rt = runtimeRef.current.get(id)
        if (!rt) return
        try {
          rt.socket?.close()
        } catch {}
        rt.disposables.forEach((d) => {
          try {
            d.dispose()
          } catch {}
        })
        try {
          rt.terminal.dispose()
        } catch {}
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
    try {
      onSessionId?.(sid)
    } catch {}
    return sid
  }, [client, onSessionId, sessionId])

  const sendFrame = useCallback((tabId: string, payload: any) => {
    const rt = runtimeRef.current.get(tabId)
    if (!rt) return
    const ws = rt.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(payload))
    } catch {}
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

      const rt: TerminalTabRuntime = {
        terminal,
        fit,
        opened: false,
        socket: null,
        state: null,
        disposables: [],
      }

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

  const connectTab = useCallback(
    async (tabId: string) => {
      const rt = ensureRuntime(tabId)
      if (rt.socket && rt.socket.readyState === WebSocket.OPEN) return
      if (rt.state) return

      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId)
        if (tab?.exited) return prev
        return prev.map((t) =>
          t.id === tabId
            ? { ...t, connecting: true, connected: false, error: undefined }
            : t
        )
      })

      // Don't attempt to connect an exited tab
      const meta = tabs.find((t) => t.id === tabId)
      if (meta?.exited) return

      try {
        const sid = await ensureSession()

        const baseUrl = wsOrigin

        openInContainer(tabId)

        const created: any = await client.serverCall(
          'terminal.create',
          {
            cols: rt.terminal.cols,
            rows: rt.terminal.rows,
          },
          sid
        )

        const terminalId = String(created?.terminal_id || '').trim()
        const token = String(
          (created?.terminal_token || created?.token) || ''
        ).trim()
        const path = String(created?.path || '/ws/terminal').trim() || '/ws/terminal'
        const resolvedCwd = created?.cwd ? String(created.cwd) : undefined

        if (!terminalId || !token) throw new Error('Terminal creation failed')

        rt.state = {
          sessionId: String(created?.session_id || sid),
          terminalId,
          terminalToken: token,
          path,
          cwd: resolvedCwd,
        }

        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, cwd: resolvedCwd } : t))
        )

        const url = new URL(baseUrl + resolvePath(path))
        url.searchParams.set('session_id', rt.state.sessionId)
        url.searchParams.set('terminal_id', terminalId)
        url.searchParams.set('terminal_token', token)
        if (authToken) url.searchParams.set('token', authToken)

        const ws = new WebSocket(url.toString())
        rt.socket = ws

        ws.onopen = () => {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? { ...t, connected: true, connecting: false }
                : t
            )
          )
          sendFrame(tabId, {
            type: 'resize',
            cols: rt.terminal.cols,
            rows: rt.terminal.rows,
          })
        }

        ws.onmessage = (ev) => {
          let msg: any = null
          try {
            msg = JSON.parse(String(ev.data))
          } catch {
            return
          }
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
              rt.terminal.writeln(
                `\r\n[process exited${code == null ? '' : `: ${code}`}]`
              )
            } catch {}
            setTabs((prev) =>
              prev.map((t) =>
                t.id === tabId
                  ? {
                      ...t,
                      connected: false,
                      connecting: false,
                      exited: true,
                      exitCode: typeof code === 'number' ? code : undefined,
                    }
                  : t
              )
            )
            try {
              rt.socket?.close()
            } catch {}
            rt.socket = null
            return
          }
        }

        ws.onerror = () => {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    error: 'Terminal connection error',
                    connected: false,
                    connecting: false,
                  }
                : t
            )
          )
          try {
            rt.socket?.close()
          } catch {}
          rt.socket = null
          // Allow reconnection by clearing state — backend terminal is destroyed on WS close
          rt.state = null
        }

        ws.onclose = () => {
          const wasExited = rt.socket === null // exit handler already cleared socket
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId ? { ...t, connected: false, connecting: false } : t
            )
          )
          rt.socket = null
          // If this wasn't a clean exit, allow reconnection by clearing state
          if (!wasExited) {
            rt.state = null
          }
        }
      } catch (e: any) {
        rt.state = null // Allow retry on failure
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  error: String(e?.message || e),
                  connected: false,
                  connecting: false,
                }
              : t
          )
        )
      }
    },
    [authToken, client, ensureRuntime, ensureSession, openInContainer, resolvePath, sendFrame, tabs, wsOrigin]
  )

  // Use refs for unstable callbacks to prevent the main effect from re-firing
  // when sessionId changes propagate through the callback chain
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
        connecting: false,
        connected: false,
        exited: false,
      },
    ])
    setActiveId(id)
  }, [])

  const closeTab = useCallback(
    async (tabId: string) => {
      const rt = runtimeRef.current.get(tabId)
      if (rt) {
        try {
          sendFrame(tabId, { type: 'close' })
        } catch {}
        try {
          rt.socket?.close()
        } catch {}
        rt.socket = null
        if (rt.state) {
          try {
            await client.serverCall(
              'terminal.close',
              { terminal_id: rt.state.terminalId },
              rt.state.sessionId
            )
          } catch {}
        }
        rt.disposables.forEach((d) => {
          try {
            d.dispose()
          } catch {}
        })
        try {
          rt.terminal.dispose()
        } catch {}
        runtimeRef.current.delete(tabId)
        containersRef.current.delete(tabId)
      }

      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId)
        const next = prev.filter((t) => t.id !== tabId)
        setActiveId((current) => {
          if (current !== tabId) return current
          if (!next.length) return undefined
          const pick = Math.max(0, idx - 1)
          return next[pick]?.id || next[0].id
        })
        return next
      })
    },
    [client, sendFrame]
  )

  // Auto-create first tab — stable deps, no spurious re-fires
  useEffect(() => {
    if (!tabs.length) addTab()
  }, [addTab, tabs.length])

  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeId) || (tabs.length ? tabs[0] : undefined)
  }, [activeId, tabs])

  // Main effect: only depends on activeTab identity (by id) and stable refs.
  // Uses refs for connectTab/openInContainer to avoid re-firing when sessionId
  // changes propagate through the callback dependency chain.
  const activeTabId = activeTab?.id
  useEffect(() => {
    if (!activeTabId) return
    setActiveId(activeTabId)
    openInContainerRef.current(activeTabId)
    const rt = runtimeRef.current.get(activeTabId)
    if (rt && rt.opened) {
      try {
        rt.fit.fit()
      } catch {}
      sendFrame(activeTabId, {
        type: 'resize',
        cols: rt.terminal.cols,
        rows: rt.terminal.rows,
      })
    }
    connectTabRef.current(activeTabId)
  }, [activeTabId, sendFrame])

  useEffect(() => {
    const onWindowResize = () => {
      if (!open) return
      const id = activeId
      if (!id) return
      const rt = runtimeRef.current.get(id)
      if (!rt || !rt.opened) return
      try {
        rt.fit.fit()
      } catch {}
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
          'absolute left-0 right-0 bottom-0 h-[70vh] bg-bgColumn border-t border-bgCardAlt flex flex-col transition-transform',
          open ? 'translate-y-0' : 'translate-y-4',
        ].join(' ')}
      >
        <div className="px-4 py-3 border-b border-bgCardAlt flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="text-base font-semibold text-textHeading">Terminal</div>
            {activeTab ? (
              <div className="text-xs text-textSecondary">
                {activeTab.connected
                  ? 'connected'
                  : activeTab.connecting
                    ? 'connecting'
                    : activeTab.exited
                      ? 'exited'
                      : 'disconnected'}
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
