import React, { useEffect, useRef } from 'react'

export interface VoiceNotification {
  id: string
  type: 'tool_called' | 'tool_result' | 'tool_approval'
  tool: string
  input?: string
  output?: string
  call_id?: string
  request_id?: string
  metadata?: any
  timestamp: number
}

interface Props {
  notifications: VoiceNotification[]
  onApprove?: (requestId: string) => void
  onReject?: (requestId: string) => void
  onDismiss?: (id: string) => void
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return ''
  const s = text.length > 200 ? text.slice(0, 200) : text
  const lines = s.split('\n')
  if (lines.length > 3) return lines.slice(0, 3).join('\n') + '\n...'
  return s.length >= max ? s.slice(0, max) + '...' : s
}

function ToolIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-green-400">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-yellow-400">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function NotificationCard({ n, onApprove, onReject, onDismiss }: {
  n: VoiceNotification
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onDismiss?: (id: string) => void
}) {
  return (
    <div
      className="pointer-events-auto max-w-[320px] rounded-xl border border-white/10 px-4 py-3 transition-all duration-300 ease-out"
      style={{
        background: 'rgba(36, 36, 40, 0.75)',
        backdropFilter: 'blur(40px) saturate(1.6)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0.5px 0 rgba(255, 255, 255, 0.06)',
      }}
      onClick={() => n.type !== 'tool_approval' && onDismiss?.(n.id)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        {n.type === 'tool_called' && <ToolIcon />}
        {n.type === 'tool_result' && <CheckIcon />}
        {n.type === 'tool_approval' && <ShieldIcon />}
        <span className="text-xs font-medium text-white/90 truncate">
          {n.type === 'tool_approval' ? 'Approve tool call?' : n.tool}
        </span>
      </div>

      {/* Body */}
      {n.type === 'tool_called' && n.input && (
        <div className="text-xs text-white/50 font-mono leading-snug mt-1 whitespace-pre-wrap break-all">
          {truncate(n.input, 120)}
        </div>
      )}

      {n.type === 'tool_result' && n.output && (
        <div className="text-xs text-white/50 font-mono leading-snug mt-1 whitespace-pre-wrap break-all">
          {truncate(n.output, 120)}
        </div>
      )}

      {n.type === 'tool_approval' && (
        <>
          <div className="text-xs text-white/70 font-medium mt-0.5">{n.tool}</div>
          {n.input && (
            <div className="text-xs text-white/50 font-mono leading-snug mt-1 whitespace-pre-wrap break-all">
              {truncate(n.input, 120)}
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={(e) => { e.stopPropagation(); onApprove?.(n.request_id!) }}
              className="flex-1 text-xs font-medium py-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/20 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onReject?.(n.request_id!) }}
              className="flex-1 text-xs font-medium py-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20 transition-colors"
            >
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function VoiceNotificationCenter({ notifications, onApprove, onReject, onDismiss }: Props) {
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Auto-dismiss tool_result cards after 4 seconds
  useEffect(() => {
    const timers = timerRefs.current
    for (const n of notifications) {
      if (n.type === 'tool_result' && !timers.has(n.id)) {
        const timer = setTimeout(() => {
          onDismiss?.(n.id)
          timers.delete(n.id)
        }, 4000)
        timers.set(n.id, timer)
      }
    }
    // Clean up timers for removed notifications
    for (const [id, timer] of timers) {
      if (!notifications.find(n => n.id === id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [notifications, onDismiss])

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timerRefs.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  if (notifications.length === 0) return null

  const visible = notifications.slice(0, 5)

  return (
    <div className="absolute top-6 right-6 z-10 flex flex-col gap-2 pointer-events-none">
      {visible.map((n, i) => (
        <div
          key={n.id}
          className="animate-[slideInRight_0.3s_ease-out]"
          style={{
            opacity: i < 3 ? 1 : 0.5,
            transform: i >= 3 ? `scale(0.95) translateY(${(i - 2) * 4}px)` : undefined,
            transition: 'opacity 0.3s, transform 0.3s',
          }}
        >
          <NotificationCard
            n={n}
            onApprove={onApprove}
            onReject={onReject}
            onDismiss={onDismiss}
          />
        </div>
      ))}
    </div>
  )
}
