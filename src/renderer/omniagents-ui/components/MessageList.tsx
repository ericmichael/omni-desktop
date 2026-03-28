import React, { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Markdown } from './promptkit/markdown'
import { Message, MessageContent, MessageActions, MessageAction } from './promptkit/Message'
import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from './ChatContainer'
import { groupItems } from './activityGroup'
import type { ActivityGroupData } from './activityGroup'
import { ActivityGroup as ActivityGroupComponent } from './ActivityGroup'
import { getGreeting } from '../greeting'

export type ChatMessage = {
  type: 'chat'
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
  attachments?: Attachment[]
}

export type Attachment = {
  type: 'image' | 'file'
  url?: string
  filename?: string
  mime?: string
  size?: number
}

export type ToolItem = {
  type: 'tool'
  call_id?: string
  tool: string
  input?: string
  output?: string
  status: 'called' | 'result'
  metadata?: any
  runId?: string
}

export type ApprovalItem = {
  type: 'approval'
  request_id: string
  tool: string
  argumentsText?: string
  metadata?: any
  session_id?: string
}

export type MessageItem = ChatMessage | ToolItem | ApprovalItem

export function MessageList({ items, greeting: greetingProp, statusText, thinking, statusSpinner, preambleText, welcomeText, onApprovalDecision, statusItalic, onReaction, currentRunId, toolStatusText }:
  { items: MessageItem[]; greeting?: string; statusText?: string; thinking?: boolean; statusSpinner?: boolean; preambleText?: string; welcomeText?: string; onApprovalDecision?: (request_id: string, value: 'yes' | 'always' | 'no') => void; statusItalic?: boolean; onReaction?: (type: 'like' | 'dislike', text?: string) => void; currentRunId?: string; toolStatusText?: string }) {
  const [fallbackGreeting] = useState(getGreeting)
  const greeting = greetingProp ?? fallbackGreeting
  const [reactions, setReactions] = useState<Record<number, 'like' | 'dislike' | undefined>>({})
  const [feedbackIndex, setFeedbackIndex] = useState<number | undefined>(undefined)
  const handleReaction = React.useCallback((index: number, type: 'like' | 'dislike') => {
    setReactions(prev => {
      const toggled = prev[index] === type ? undefined : type
      if (toggled) {
        setFeedbackIndex(index)
      } else {
        setFeedbackIndex(undefined)
      }
      return { ...prev, [index]: toggled }
    })
  }, [])
  const handleFeedbackSubmit = React.useCallback((index: number, text: string) => {
    const type = reactions[index]
    if (type) onReaction?.(type, text)
    setFeedbackIndex(undefined)
  }, [reactions, onReaction])
  const handleFeedbackDismiss = React.useCallback(() => {
    const idx = feedbackIndex
    if (idx !== undefined) {
      const type = reactions[idx]
      if (type) onReaction?.(type)
    }
    setFeedbackIndex(undefined)
  }, [feedbackIndex, reactions, onReaction])
  const displayItems = useMemo(() => groupItems(items, currentRunId, !!thinking), [items, currentRunId, thinking])
  const lastDisplay = displayItems[displayItems.length - 1]
  const hasRunningGroup = lastDisplay?.type === 'activity_group' && (lastDisplay as ActivityGroupData).isRunning
  // When a running group is active, show toolStatusText in the ticker (persists across fast tool_result clears)
  const tickerStatus = hasRunningGroup ? toolStatusText : undefined
  const fallbackStatus = thinking ? (hasRunningGroup ? 'Working…' : 'Thinking…') : ''
  const statusRowText = hasRunningGroup ? undefined : statusText
  if (items.length === 0) {
    return (
      <div className="flex-1 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="mx-auto max-w-2xl text-center px-4">
            <div className="text-4xl font-normal tracking-tight text-textHeading font-serif">
              {greeting}
            </div>
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={welcomeText ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.5, delay: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="overflow-hidden"
            >
              <div className="mt-3 text-sm text-textSubtle">{welcomeText}</div>
            </motion.div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <ChatContainerRoot className="flex-1">
      <ChatContainerContent className="container-chat px-3 py-3 space-y-3 md:space-y-4">
        {(
          displayItems.map((m, i) => {
            if (m.type === 'activity_group') return <ActivityGroupComponent key={(m as any).runId + '-' + i} group={m as any} statusText={tickerStatus} />
            if (m.type === 'chat') return <MessageBubble key={i} index={i} role={(m as ChatMessage).role} content={(m as ChatMessage).content} attachments={(m as ChatMessage).attachments} reactions={reactions} onReact={handleReaction} feedbackIndex={feedbackIndex} onFeedbackSubmit={handleFeedbackSubmit} onFeedbackDismiss={handleFeedbackDismiss} />
            if (m.type === 'tool') return <ToolCard key={(m as ToolItem).call_id || i} item={m as ToolItem} />
            if (m.type === 'approval') return <ApprovalCard key={(m as ApprovalItem).request_id} item={m as ApprovalItem} onDecision={onApprovalDecision} />
            return null
          })
        )}
        {preambleText ? <PreambleRow text={preambleText} /> : null}
        {(thinking || statusRowText) ? (
          <StatusRow text={statusRowText || fallbackStatus} spinner={!!statusSpinner || !!thinking} italic={!!statusItalic && !thinking} />
        ) : null}
        <ChatContainerScrollAnchor />
      </ChatContainerContent>
    </ChatContainerRoot>
  )
}

function MessageBubble({ index, role, content, attachments, reactions, onReact, feedbackIndex, onFeedbackSubmit, onFeedbackDismiss }: { index: number; role: ChatMessage['role']; content: string; attachments?: Attachment[]; reactions?: Record<number, 'like' | 'dislike' | undefined>; onReact?: (index: number, type: 'like' | 'dislike') => void; feedbackIndex?: number; onFeedbackSubmit?: (index: number, text: string) => void; onFeedbackDismiss?: () => void }) {
  const [feedbackText, setFeedbackText] = useState('')
  const showFeedback = feedbackIndex === index
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end max-w-[70%] space-y-3">
          {attachments && attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full justify-end">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          <Message>
            <MessageContent markdown className="rounded-[18px] bg-tweetBlue text-white">
              {content}
            </MessageContent>
          </Message>
        </div>
      </div>
    )
  }
  if (role === 'system') {
    return (
      <div className="flex justify-start">
        <div className="flex flex-col items-start max-w-[70%]">
          {attachments && attachments.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-2 w-full">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          <Message>
            <MessageContent markdown className="rounded-[8px] bg-bgCardAlt text-textPrimary border border-bgCardAlt">
              {content}
            </MessageContent>
          </Message>
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="flex flex-col items-start max-w-[70%]">
        {attachments && attachments.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-2 w-full">
            {attachments.map((att, i) => (
              <AttachmentChip key={i} attachment={att} />
            ))}
          </div>
        ) : null}
        <Message>
          <div className="flex flex-col items-start">
            <MessageContent markdown className="bg-transparent rounded-none p-0">
              {content}
            </MessageContent>
            <MessageActions className="mt-1">
              <MessageAction tooltip="Copy">
                <button
                  onClick={() => { try { navigator.clipboard.writeText(content) } catch {} }}
                  className="hover:bg-bgCardAlt rounded p-1 text-textSubtle hover:text-textHeading active:opacity-50"
                  aria-label="Copy"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M16 1H4a2 2 0 00-2 2v12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <rect x="8" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </MessageAction>
              <MessageAction tooltip="Like">
                <button
                  onClick={() => onReact && onReact(index, 'like')}
                  className={[reactions && reactions[index] === 'like' ? 'text-successGreen' : 'text-textSubtle', 'hover:bg-bgCardAlt rounded p-1 hover:text-textHeading'].join(' ')}
                  aria-label="Like"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 9V5a3 3 0 00-3-3l-2 5-5 6v5a2 2 0 002 2h9a2 2 0 002-2l1-7a2 2 0 00-2-2h-5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </MessageAction>
              <MessageAction tooltip="Dislike">
                <button
                  onClick={() => onReact && onReact(index, 'dislike')}
                  className={[reactions && reactions[index] === 'dislike' ? 'text-errorRed' : 'text-textSubtle', 'hover:bg-bgCardAlt rounded p-1 hover:text-textHeading'].join(' ')}
                  aria-label="Dislike"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M10 15v4a3 3 0 003 3l2-5 5-6V6a2 2 0 00-2-2h-9a2 2 0 00-2 2l-1 7a2 2 0 00-2 2h5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </MessageAction>
            </MessageActions>
            {showFeedback && (
              <div className="mt-2 flex items-center gap-2 w-full">
                <input
                  type="text"
                  autoFocus
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onFeedbackSubmit?.(index, feedbackText)
                      setFeedbackText('')
                    } else if (e.key === 'Escape') {
                      onFeedbackDismiss?.()
                      setFeedbackText('')
                    }
                  }}
                  placeholder="Add a note (optional)…"
                  className="flex-1 h-7 px-2 rounded-md bg-bgCardAlt text-xs text-textPrimary placeholder-textSubtle border border-transparent focus:border-tweetBlue focus:outline-none"
                />
                <button
                  onClick={() => { onFeedbackSubmit?.(index, feedbackText); setFeedbackText('') }}
                  className="h-7 px-2 rounded-md bg-tweetBlue text-white text-xs hover:brightness-110"
                >
                  Submit
                </button>
                <button
                  onClick={() => { onFeedbackDismiss?.(); setFeedbackText('') }}
                  className="h-7 px-2 rounded-md text-textSubtle text-xs hover:text-textHeading hover:bg-bgCardAlt"
                >
                  Skip
                </button>
              </div>
            )}
          </div>
        </Message>
      </div>
    </div>
  )
}

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  if (attachment.type === 'image' && attachment.url) {
    return (
      <div className="rounded-lg overflow-hidden border border-bgCardAlt bg-bgCardAlt">
        <img
          src={attachment.url}
          alt={attachment.filename || 'image'}
          className="block max-h-[160px] max-w-[240px] object-cover"
        />
      </div>
    )
  }
  return (
    <div className="bg-bgCard flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-bgCardAlt">
      <svg width="16" height="16" viewBox="0 0 24 24" className="text-white" aria-hidden="true">
        <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 11-7.78-7.78l8.49-8.49a3.5 3.5 0 114.95 4.95l-8.49 8.49a1.5 1.5 0 11-2.12-2.12l8.49-8.49" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span className="max-w-[180px] truncate text-white" title={attachment.filename || 'file'}>
        {attachment.filename || 'file'}
      </span>
    </div>
  )
}

function PreambleRow({ text }: { text?: string }) {
  if (!text) return null
  return (
    <div className="flex items-start gap-2">
      <span className="text-warningOrange animate-pulse mt-[2px]">✶</span>
      <Markdown className="prose-sm prose-warning" highlight={false} inheritTextColor>{text}</Markdown>
    </div>
  )
}

function StatusRow({ text, spinner, italic }: { text?: string; spinner?: boolean; italic?: boolean }) {
  if (!text) return null
  return (
    <div className="text-xs text-textSubtle">
      <span className={spinner ? 'text-shimmer italic' : 'italic'}>{text}</span>
    </div>
  )
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const hasResult = item.status === 'result'
  const iconFill = hasResult ? 'bg-successGreen' : 'bg-warningOrange'
  const headerNode = useMemo(() => {
    const meta = item.metadata
    const sum = meta && typeof meta === 'object' ? String(meta.summary || '') : ''
    if (sum && sum.trim().length > 0) return <span>{sum.trim()}</span>
    const preview = formatArgsPreview(item.input || '', 80)
    return (
      <>
        <span>{item.tool}</span>
        {preview ? <span className="text-textSubtle"> ({preview})</span> : null}
      </>
    )
  }, [item.tool, item.input, item.metadata])
  const titleNode = hasResult ? headerNode : (
    <>
      {headerNode}
      <span className="text-textSubtle"> • running…</span>
    </>
  )
  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0">
        <div className="rounded-md border border-bgCardAlt bg-bgCardAlt p-3">
          <div className="flex items-center gap-2">
            <span className={["inline-block w-2 h-2 rounded-full flex-shrink-0", iconFill].join(' ')} />
            <div className="flex-1 min-w-0 text-sm text-textPrimary">{titleNode}</div>
            <button
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-bgColumn text-textSubtle hover:text-textHeading"
              aria-label="Toggle details"
              onClick={() => setOpen(v => !v)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={[open ? 'rotate-180' : '', 'transition-transform'].join(' ')}>
                <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {open ? (
            <div className="mt-2 space-y-3">
              {renderToolBody(item)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ApprovalCard({ item, onDecision }: { item: ApprovalItem; onDecision?: (request_id: string, value: 'yes' | 'always' | 'no') => void }) {
  const meta = item.metadata
  const summary = meta && typeof meta === 'object' && typeof meta.summary === 'string' ? meta.summary : ''
  const richBody = renderMetadata(meta, item.argumentsText || '')
  return (
    <div className="rounded-md border border-warningOrange bg-bgCardAlt p-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold text-warningOrange">Approve {item.tool}</div>
        {summary ? <div className="text-xs text-textSubtle">{summary}</div> : null}
      </div>
      <div className="mt-2">
        {richBody || (item.argumentsText ? (
          <pre className="text-xs overflow-x-auto whitespace-pre-wrap bg-bgColumn rounded p-2 border border-bgCardAlt text-textPrimary">{item.argumentsText}</pre>
        ) : (
          <div className="text-xs text-textSubtle">No parameters</div>
        ))}
      </div>
      <div className="mt-3 flex gap-2 justify-end">
        <button className="px-3 py-1.5 text-xs rounded-md border border-errorRed text-errorRed bg-transparent hover:bg-errorRed/20" onClick={() => onDecision && onDecision(item.request_id, 'no')}>Reject</button>
        <button className="px-3 py-1.5 text-xs rounded-md border border-tweetBlue text-tweetBlue bg-transparent hover:bg-bgColumn" onClick={() => onDecision && onDecision(item.request_id, 'always')}>Always</button>
        <button className="px-3 py-1.5 text-xs rounded-md bg-tweetBlue hover:brightness-110 text-white" onClick={() => onDecision && onDecision(item.request_id, 'yes')}>Approve Once</button>
      </div>
    </div>
  )
}

function buildToolHeader(tool: string, args?: string) {
  const preview = formatArgsPreview(args || '', 80)
  if (!preview) return tool
  return `${tool}(${preview})`
}

export function formatArgsPreview(args: string, maxLen: number) {
  if (!args) return ''
  let parsed: any
  try { parsed = JSON.parse(args) } catch {}
  let text: string
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const parts: string[] = []
    Object.entries(parsed).forEach(([k, v]) => {
      let vs: string
      if (typeof v === 'string') vs = `"${v}"`
      else if (typeof v === 'number' || typeof v === 'boolean') vs = String(v)
      else {
        try { vs = JSON.stringify(v) } catch { vs = String(v) }
      }
      parts.push(`${k}: ${vs}`)
    })
    text = parts.join(', ')
  } else {
    text = args.replace(/\s+/g, ' ').trim()
  }
  if (text.length > maxLen) return text.slice(0, maxLen - 3) + '...'
  return text
}

function renderMetadata(meta: any, fallbackText: string): React.ReactNode | null {
  if (meta && typeof meta === 'object' && meta.display_type) {
    const dt = meta.display_type as string
    if (dt === 'diff') return diffView(linesFromDiff(meta))
    if (dt === 'table') return tableView(meta)
    if (dt === 'file_write') return codeBlock((meta.value as string) || fallbackText)
    if (dt === 'command') return commandView(meta, fallbackText)
    if (dt === 'file_content') return fileContentView(meta, fallbackText)
    if (dt === 'directory_listing') return directoryListingView(meta, fallbackText)
    if (dt === 'search_results') return searchResultsView(meta, fallbackText)
    if (dt === 'web_content') return webContentView(meta, fallbackText)
    if (dt === 'error') return errorView(meta, fallbackText)
    if (typeof meta.preview === 'string' && meta.preview.trim().length > 0) return preText(meta.preview)
  }
  return null
}

function renderToolBody(item: ToolItem) {
  const out = item.output || ''
  if (!out.trim().length) return null
  const richView = renderMetadata(item.metadata, out)
  if (richView) return <div className="space-y-3">{richView}</div>
  return <div className="space-y-3">{preText(out)}</div>
}

function linesFromDiff(metadata: any): string[] {
  const v = metadata?.value
  const acc: string[] = []
  if (v && typeof v === 'object' && Array.isArray(v.diff_lines)) {
    for (const s of v.diff_lines) if (typeof s === 'string') acc.push(s)
  }
  return acc
}

function diffView(lines: string[]) {
  const rows = lines.map((l, i) => {
    const cls = l.startsWith('+') && !l.startsWith('+++') ? 'text-successGreen' : (l.startsWith('-') && !l.startsWith('---') ? 'text-errorRed' : 'text-textSubtle')
    return <div key={i} className={[cls, 'font-mono text-[12px] whitespace-pre'].join(' ')}>{l}</div>
  })
  return (
    <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
      <div className="space-y-0.5 min-w-fit">{rows}</div>
    </div>
  )
}

function tableView(metadata: any) {
  const t = metadata?.table || {}
  const cols: string[] = Array.isArray(t.columns) ? t.columns.map((c: any) => (c && typeof c === 'object' ? c.title : '')).filter(Boolean) : []
  const rows: string[][] = Array.isArray(t.rows) ? t.rows.map((r: any) => Array.isArray(r) ? r.map((e: any) => (e == null ? '' : String(e))) : []).filter((r: any) => r.length) : []
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            {cols.map((c, i) => <th key={i} className="text-left font-semibold pr-4 pb-1">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((cell, j) => <td key={j} className="pr-4 py-1 whitespace-nowrap">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function codeBlock(content: string) {
  return (
    <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
      <pre className="whitespace-pre-wrap text-[12px] text-textPrimary"><code>{content}</code></pre>
    </div>
  )
}

function preText(content: string) {
  return (
    <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
      <pre className="whitespace-pre-wrap text-[12px] text-textPrimary"><code>{content}</code></pre>
    </div>
  )
}

function commandView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  let command = plainOutput || ''
  if (typeof meta?.command === 'string') command = meta.command
  let output = ''
  const value = metadata?.value
  if (typeof value === 'string' && value.trim().length > 0) output = value
  else if (typeof metadata?.preview === 'string' && metadata.preview.trim().length > 0) output = metadata.preview
  else {
    const stdout = meta?.stdout
    const stderr = meta?.stderr
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim().length > 0) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim().length > 0) parts.push('[stderr]\n' + stderr)
    if (parts.length) output = parts.join('\n')
    if (!output && plainOutput && plainOutput.trim().length > 0) output = plainOutput
  }
  const status: string[] = []
  if (typeof meta?.success === 'boolean') status.push(meta.success ? 'success' : 'failed')
  if (typeof meta?.exit_code === 'number') status.push('exit ' + String(meta.exit_code))
  if (typeof meta?.wall_time_ms === 'number') status.push(meta.wall_time_ms + 'ms')
  if (typeof meta?.was_truncated === 'boolean' && meta.was_truncated) {
    const charsTruncated = meta?.chars_truncated
    status.push(typeof charsTruncated === 'number' ? `${charsTruncated.toLocaleString()} chars truncated` : 'truncated')
  }
  if (typeof meta?.has_stderr === 'boolean' && meta.has_stderr) status.push('stderr captured')
  const statusColor = meta?.success === false ? 'text-errorRed' : 'text-textSubtle'
  return (
    <div className="space-y-2">
      <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn font-mono text-[12px]">$ {String(command)}</div>
      {status.length ? <div className={["text-[12px]", statusColor].join(' ')}>{status.join(' • ')}</div> : null}
      {output.trim().length ? preText(output.trimEnd()) : null}
    </div>
  )
}

function fileContentView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  // Tool provides: total_file_lines, lines_returned, lines_truncated_count, start_line, end_line
  if (typeof meta?.total_file_lines === 'number') stats.push(`${meta.total_file_lines.toLocaleString()} lines total`)
  if (typeof meta?.lines_truncated_count === 'number' && meta.lines_truncated_count > 0) stats.push(`${meta.lines_truncated_count} long lines truncated`)
  if (typeof meta?.start_line === 'number' && typeof meta?.end_line === 'number') {
    stats.push(`showing L${meta.start_line}-${meta.end_line}`)
  }
  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-textSubtle">{stats.join(' • ')}</div> : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
        <pre className="whitespace-pre-wrap text-[12px] text-textPrimary font-mono"><code>{preview}</code></pre>
      </div>
    </div>
  )
}

function directoryListingView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  // Tool provides: total_entries, entries_returned, file_count, dir_count, symlink_count, was_truncated
  if (typeof meta?.total_entries === 'number') stats.push(`${meta.total_entries.toLocaleString()} entries`)
  if (typeof meta?.file_count === 'number') stats.push(`${meta.file_count} files`)
  if (typeof meta?.dir_count === 'number') stats.push(`${meta.dir_count} dirs`)
  if (typeof meta?.symlink_count === 'number' && meta.symlink_count > 0) stats.push(`${meta.symlink_count} symlinks`)
  if (typeof meta?.was_truncated === 'boolean' && meta.was_truncated) stats.push('truncated')

  // Parse and render entries with formatting
  const lines = preview.split('\n')
  const formattedLines = lines.map((line, i) => {
    // Entry lines with numbering (e.g., "  1. src/")
    const entryMatch = line.match(/^\s*(\d+)\.\s+(.+)$/)
    if (entryMatch) {
      const entryName = entryMatch[2]
      const isDir = entryName.endsWith('/')
      const isSymlink = entryName.includes(' → ')
      const className = isDir ? 'font-semibold' : (isSymlink ? 'text-tweetBlue' : '')
      return <div key={i} className={["font-mono text-[12px]", className].join(' ')}>{line}</div>
    }
    return <div key={i} className="font-mono text-[12px]">{line}</div>
  })

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-textSubtle">{stats.join(' • ')}</div> : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
        {formattedLines}
      </div>
    </div>
  )
}

function searchResultsView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  // Tool provides: files_with_matches, files_returned, files_searched, elapsed_ms, timed_out
  if (typeof meta?.files_with_matches === 'number') stats.push(`${meta.files_with_matches} files with matches`)
  if (typeof meta?.files_searched === 'number') stats.push(`${meta.files_searched.toLocaleString()} files searched`)
  if (typeof meta?.elapsed_ms === 'number') stats.push(`${meta.elapsed_ms}ms`)
  if (typeof meta?.timed_out === 'boolean' && meta.timed_out) stats.push('timed out')
  if (typeof metadata?.truncated === 'boolean' && metadata.truncated) stats.push('truncated')

  // Parse and highlight file paths vs content
  const lines = preview.split('\n')
  const formattedLines = lines.map((line, i) => {
    // File header line (e.g., "src/utils.py: 8 matches")
    if (line.includes(': ') && (line.includes('match') || line.match(/:\s*\d+\s*$/))) {
      return <div key={i} className="font-mono text-[12px] font-semibold text-tweetBlue">{line}</div>
    }
    return <div key={i} className="font-mono text-[12px] text-textPrimary">{line}</div>
  })

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-textSubtle">{stats.join(' • ')}</div> : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
        {formattedLines}
      </div>
    </div>
  )
}

function webContentView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  if (typeof meta?.title === 'string' && meta.title.trim()) stats.push(meta.title)
  if (typeof meta?.elapsed_ms === 'number') stats.push(`${meta.elapsed_ms}ms`)
  if (typeof meta?.link_count === 'number') stats.push(`${meta.link_count} links`)
  if (typeof meta?.links_truncated === 'boolean' && meta.links_truncated && typeof meta?.total_links === 'number') {
    stats.push(`(${meta.total_links} total)`)
  }

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-textSubtle">{stats.join(' • ')}</div> : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-bgCardAlt bg-bgColumn">
        <pre className="whitespace-pre-wrap text-[12px] text-textPrimary"><code>{preview}</code></pre>
      </div>
    </div>
  )
}

function errorView(metadata: any, plainOutput: string) {
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const summary = typeof metadata?.summary === 'string' ? metadata.summary : ''
  const meta = metadata?.metadata || {}
  const errorType = typeof meta?.error_type === 'string' ? meta.error_type : ''

  return (
    <div className="space-y-2">
      {(summary || errorType) ? (
        <div className="text-[12px] text-errorRed font-medium">
          {summary || errorType}
        </div>
      ) : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-errorRed/30 bg-errorRed/10">
        <pre className="whitespace-pre-wrap text-[12px] text-errorRed"><code>{preview}</code></pre>
      </div>
    </div>
  )
}
