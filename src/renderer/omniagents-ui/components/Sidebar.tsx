import React, { useMemo, useState } from 'react'

import { cn,formatRelativeTime, generateSessionTitle } from '@/renderer/omniagents-ui/lib/utils'

import type { SessionItem } from './SessionList'

export function Sidebar({ open, sessions, selectedId, onClose, onNewChat, onSelect, onDelete }:
  {
    open: boolean
    sessions: SessionItem[]
    selectedId?: string
    onClose: () => void
    onNewChat: () => void
    onSelect: (id: string) => void
    onDelete?: (id: string) => void
  }) {
  const [searchQuery, setSearchQuery] = useState('')

  const ordered = useMemo(() => {
    const ts = (s: any) => {
      const t = s?.last_message?.timestamp || s?.created_at
      const n = Date.parse(String(t || ''))
      return isNaN(n) ? 0 : n
    }
    return sessions.slice().sort((a: any, b: any) => ts(b) - ts(a))
  }, [sessions])

  const nonEmpty = useMemo(() => ordered.filter(s => s.message_count > 0), [ordered])

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) {
return nonEmpty
}
    const query = searchQuery.toLowerCase()
    return nonEmpty.filter(s => {
      const title = generateSessionTitle(s).toLowerCase()
      const id = s.id.toLowerCase()
      return title.includes(query) || id.includes(query)
    })
  }, [nonEmpty, searchQuery])

  const renderSessionItem = (s: SessionItem, closeOnClick: boolean = false) => {
    const title = generateSessionTitle(s)
    const timestamp = formatRelativeTime(s.last_message?.timestamp || s.created_at)
    const isSelected = selectedId === s.id

    return (
      <div key={s.id} className="relative">
        <button
          onClick={() => {
            onSelect(s.id)
            if (closeOnClick) {
onClose()
}
          }}
          className={cn(
            'relative w-full text-left px-3 py-2.5 rounded-lg transition-all group border',
            isSelected
              ? 'bg-bgCard ring-1 ring-tweetBlue/30 shadow-sm border-transparent'
              : 'bg-bgCardAlt hover:bg-bgCard border-transparent hover:border-textSubtle/30'
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-textPrimary truncate mb-1">{title}</div>
              <div className="text-xs text-textSubtle flex items-center gap-2">
                <span>{timestamp}</span>
                {s.message_count > 0 && (
                  <>
                    <span>•</span>
                    <span>{s.message_count} {s.message_count === 1 ? 'message' : 'messages'}</span>
                  </>
                )}
              </div>
            </div>
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm('Delete this conversation?')) {
                    onDelete(s.id)
                  }
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 hover:bg-errorRed/10 rounded text-textSubtle hover:text-errorRed"
                aria-label="Delete conversation"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        </button>
      </div>
    )
  }

  const emptyState = (
    <div className="flex flex-col items-center justify-center h-full text-textSubtle px-6 text-center py-8">
      <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
      <p className="text-sm">No conversations yet</p>
      <p className="text-xs mt-1">Start chatting to create your first session</p>
    </div>
  )

  const sidebarContent = (closeOnClick: boolean = false) => (
    <>
      <div className="p-2 border-b border-bgCardAlt flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-textSubtle uppercase tracking-wide px-1">Conversations</span>
          <button className="w-8 h-8 rounded hover:bg-bgCardAlt text-textPrimary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <button
          className="w-full h-10 rounded-lg flex items-center justify-center gap-2 text-sm font-medium text-textPrimary bg-bgCardAlt hover:bg-bgCard border border-transparent hover:border-textSubtle/30 transition-all"
          onClick={onNewChat}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          New Chat
        </button>
      </div>

      {nonEmpty.length > 0 && (
        <div className="px-2 pt-2 pb-1 border-b border-bgCardAlt flex-shrink-0">
          <div className="relative">
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 px-3 pr-8 rounded-md bg-bgCardAlt text-sm text-textPrimary placeholder-textSubtle border border-transparent focus:border-tweetBlue focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-textSubtle hover:text-textPrimary"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
            {!searchQuery && (
              <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-textSubtle pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 p-2 space-y-2 overflow-y-auto min-h-0">
        {filtered.length === 0 && nonEmpty.length > 0 ? (
          <div className="text-center text-textSubtle text-sm py-4">
            No matching conversations
          </div>
        ) : filtered.length === 0 ? (
          emptyState
        ) : (
          filtered.map(s => renderSessionItem(s, closeOnClick))
        )}
      </div>
    </>
  )

  return (
    <>
      {/* Desktop/Tablet: Inline sidebar beside content */}
      {open && (
        <div className="hidden md:flex md:flex-col md:w-72 md:border-r md:border-bgCardAlt md:bg-bgColumn md:flex-shrink-0 md:h-full">
          {sidebarContent(false)}
        </div>
      )}

      {/* Mobile: Full overlay with backdrop */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <div className="absolute left-0 top-0 bottom-0 w-[85vw] max-w-72 bg-bgColumn border-r border-bgCardAlt flex flex-col">
            {sidebarContent(true)}
          </div>
        </div>
      )}
    </>
  )
}

export default Sidebar
