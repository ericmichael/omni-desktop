import { motion } from 'framer-motion'
import { CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, PaperclipIcon,ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react'
import React, { useCallback,useEffect, useMemo, useState } from 'react'

import { getGreeting } from '@/renderer/omniagents-ui/greeting'

import { ActivityGroup as ActivityGroupComponent } from './ActivityGroup'
import type { ActivityGroupData } from './activity-group'
import { groupItems } from './activity-group'
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from './ai/artifact'
import { CodeBlock } from './ai/code-block'
import { MessageResponse } from './ai/message'
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
} from './ai/plan'
import { Shimmer } from './ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from './ai/tool'
import { ChatContainerContent, ChatContainerRoot, ChatContainerScrollAnchor } from './ChatContainer'
import { Markdown } from './promptkit/markdown'

export type { ApprovalItem, ArtifactItem, Attachment, ChatMessage, MessageItem, PlanItem, ToolItem } from '@/shared/chat-types'
import type { ApprovalItem, ArtifactItem, Attachment, ChatMessage, MessageItem, PlanItem, ToolItem } from '@/shared/chat-types'

export function MessageList({ items, greeting: greetingProp, statusText, thinking, statusSpinner, preambleText, welcomeText, onApprovalDecision, pendingPlan, onPlanDecision, statusItalic, onReaction, currentRunId, toolStatusText }:
  { items: MessageItem[]; greeting?: string; statusText?: string; thinking?: boolean; statusSpinner?: boolean; preambleText?: string; welcomeText?: string; onApprovalDecision?: (request_id: string, value: 'yes' | 'always' | 'no') => void; pendingPlan?: PlanItem | null; onPlanDecision?: (approved: boolean) => void; statusItalic?: boolean; onReaction?: (type: 'like' | 'dislike', text?: string) => void; currentRunId?: string; toolStatusText?: string }) {
  const [fallbackGreeting] = useState(getGreeting)
  const greeting = greetingProp ?? fallbackGreeting
  const [reactions, setReactions] = useState<Record<number, 'like' | 'dislike' | undefined>>({})
  const [feedbackIndex, setFeedbackIndex] = useState<number | undefined>(undefined)
  const handleReaction = useCallback((index: number, type: 'like' | 'dislike') => {
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
  const handleFeedbackSubmit = useCallback((index: number, text: string) => {
    const type = reactions[index]
    if (type) {
onReaction?.(type, text)
}
    setFeedbackIndex(undefined)
  }, [reactions, onReaction])
  const handleFeedbackDismiss = useCallback(() => {
    const idx = feedbackIndex
    if (idx !== undefined) {
      const type = reactions[idx]
      if (type) {
onReaction?.(type)
}
    }
    setFeedbackIndex(undefined)
  }, [feedbackIndex, reactions, onReaction])
  const displayItems = useMemo(() => groupItems(items, currentRunId, !!thinking), [items, currentRunId, thinking])
  const lastDisplay = displayItems[displayItems.length - 1]
  const hasRunningGroup = lastDisplay?.type === 'activity_group' && (lastDisplay as ActivityGroupData).isRunning
  const tickerStatus = hasRunningGroup ? toolStatusText : undefined
  const fallbackStatus = thinking ? (hasRunningGroup ? 'Working…' : 'Thinking…') : ''
  const statusRowText = hasRunningGroup ? undefined : statusText
  if (items.length === 0) {
    return (
      <div className="flex-1 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="mx-auto max-w-full sm:max-w-2xl text-center px-6">
            <div className="text-2xl sm:text-4xl font-normal tracking-tight text-textHeading font-serif">
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
        {(() => {
          const pendingApprovalIds: string[] = []
          for (const it of displayItems) {
            if (it && (it as { type?: string }).type === 'approval') {
              pendingApprovalIds.push((it as ApprovalItem).request_id)
            }
          }
          const queueTotal = pendingApprovalIds.length
          return displayItems.map((m, i) => {
            if (m.type === 'activity_group') {
return <ActivityGroupComponent key={`${(m as any).runId  }-${  i}`} group={m as any} statusText={tickerStatus} />
}
            if (m.type === 'chat') {
return <MessageBubble key={i} index={i} role={(m as ChatMessage).role} content={(m as ChatMessage).content} attachments={(m as ChatMessage).attachments} reactions={reactions} onReact={handleReaction} feedbackIndex={feedbackIndex} onFeedbackSubmit={handleFeedbackSubmit} onFeedbackDismiss={handleFeedbackDismiss} />
}
            if (m.type === 'tool') {
return <ToolCard key={(m as ToolItem).call_id || i} item={m as ToolItem} />
}
            if (m.type === 'artifact') {
return <InlineArtifact key={(m as ArtifactItem).artifact_id || i} item={m as ArtifactItem} />
}
            if (m.type === 'approval') {
              const reqId = (m as ApprovalItem).request_id
              const idx = pendingApprovalIds.indexOf(reqId)
              const queuePosition = idx >= 0 ? idx + 1 : 1
              return <ApprovalCard key={reqId} item={m as ApprovalItem} onDecision={onApprovalDecision} queuePosition={queuePosition} queueTotal={queueTotal} />
            }
            return null
          })
        })()}
        {pendingPlan ? <PlanCard key={pendingPlan.id} item={pendingPlan} onDecision={onPlanDecision} /> : null}
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
        <div className="flex flex-col items-end max-w-[85%] sm:max-w-[70%] space-y-3">
          {attachments && attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full justify-end">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          <div className="rounded-[18px] bg-primary text-primary-foreground px-4 py-3 text-sm">
            <MessageResponse>{content}</MessageResponse>
          </div>
        </div>
      </div>
    )
  }
  if (role === 'system') {
    return (
      <div className="flex justify-start">
        <div className="flex flex-col items-start max-w-[85%] sm:max-w-[70%]">
          {attachments && attachments.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-2 w-full">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          <div className="rounded-lg bg-secondary text-secondary-foreground border border-border px-4 py-3 text-sm">
            <MessageResponse>{content}</MessageResponse>
          </div>
        </div>
      </div>
    )
  }
  // assistant
  return (
    <div className="flex justify-start">
      <div className="flex flex-col items-start max-w-[85%] sm:max-w-[70%]">
        {attachments && attachments.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-2 w-full">
            {attachments.map((att, i) => (
              <AttachmentChip key={i} attachment={att} />
            ))}
          </div>
        ) : null}
        <div className="flex flex-col items-start">
          <div className="text-sm text-foreground">
            <MessageResponse>{content}</MessageResponse>
          </div>
          <div className="mt-1 flex items-center gap-1">
            <button
              onClick={() => {
 try {
 navigator.clipboard.writeText(content) 
} catch {} 
}}
              className="hover:bg-accent rounded p-1 text-muted-foreground hover:text-foreground active:opacity-50"
              aria-label="Copy"
            >
              <CopyIcon size={16} />
            </button>
            <button
              onClick={() => onReact && onReact(index, 'like')}
              className={`hover:bg-accent rounded p-1 hover:text-foreground ${reactions && reactions[index] === 'like' ? 'text-successGreen' : 'text-muted-foreground'}`}
              aria-label="Like"
            >
              <ThumbsUpIcon size={16} />
            </button>
            <button
              onClick={() => onReact && onReact(index, 'dislike')}
              className={`hover:bg-accent rounded p-1 hover:text-foreground ${reactions && reactions[index] === 'dislike' ? 'text-errorRed' : 'text-muted-foreground'}`}
              aria-label="Dislike"
            >
              <ThumbsDownIcon size={16} />
            </button>
          </div>
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
                className="flex-1 h-9 px-3 rounded-lg bg-secondary text-sm text-foreground placeholder-muted-foreground border border-transparent focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => {
 onFeedbackSubmit?.(index, feedbackText); setFeedbackText('') 
}}
                className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-sm hover:brightness-110"
              >
                Submit
              </button>
              <button
                onClick={() => {
 onFeedbackDismiss?.(); setFeedbackText('') 
}}
                className="h-9 px-3 rounded-lg text-muted-foreground text-sm hover:text-foreground hover:bg-accent"
              >
                Skip
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function InlineArtifact({ item }: { item: ArtifactItem }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    try {
 navigator.clipboard.writeText(item.content) 
} catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [item.content])

  return (
    <div className="flex justify-start" data-artifact-id={item.artifact_id || undefined}>
      <div className="w-full min-w-0">
        <Artifact>
          <ArtifactHeader>
            <ArtifactTitle>{item.title || 'Artifact'}</ArtifactTitle>
            <ArtifactActions>
              <ArtifactAction
                tooltip={copied ? 'Copied!' : 'Copy'}
                icon={CopyIcon}
                onClick={handleCopy}
              />
            </ArtifactActions>
          </ArtifactHeader>
          <ArtifactContent>
            <InlineArtifactBody item={item} />
          </ArtifactContent>
        </Artifact>
      </div>
    </div>
  )
}

function InlineArtifactBody({ item }: { item: ArtifactItem }) {
  const mode = String(item.mode || 'markdown')

  if (mode === 'markdown') {
    return (
      <Markdown className="prose-sm" highlight inheritTextColor>
        {item.content}
      </Markdown>
    )
  }

  if (mode === 'html') {
    return <InlineHtmlPreview content={item.content} />
  }

  if (mode === 'image') {
    return <img src={item.content} alt={item.title || 'artifact'} className="max-w-full rounded" />
  }

  // plain text / unknown
  return <pre className="whitespace-pre-wrap break-words text-sm">{item.content}</pre>
}

function InlineHtmlPreview({ content }: { content: string }) {
  const [height, setHeight] = useState(200)

  const script = `<script>
    function sendHeight(){window.parent.postMessage({type:'iframe-resize',height:document.body.scrollHeight},'*')}
    window.addEventListener('load',sendHeight);
    new ResizeObserver(sendHeight).observe(document.body);
  <\/script>`
  const srcDoc = content + script

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'iframe-resize' && typeof e.data.height === 'number') {
        setHeight(Math.min(e.data.height + 16, 800))
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      style={{ width: '100%', height, border: 'none', borderRadius: 6, background: '#fff' }}
    />
  )
}

function AttachmentChip({ attachment }: { attachment: Attachment }) {
  if (attachment.type === 'image' && attachment.url) {
    return (
      <div className="rounded-lg overflow-hidden border border-border bg-secondary">
        <img
          src={attachment.url}
          alt={attachment.filename || 'image'}
          className="block max-h-[160px] max-w-[240px] object-cover"
        />
      </div>
    )
  }
  return (
    <div className="bg-card flex items-center gap-2 rounded-lg px-3 py-2 text-sm border border-border">
      <PaperclipIcon size={16} className="text-foreground" />
      <span className="max-w-[180px] truncate text-foreground" title={attachment.filename || 'file'}>
        {attachment.filename || 'file'}
      </span>
    </div>
  )
}

function PreambleRow({ text }: { text?: string }) {
  if (!text) {
return null
}
  return (
    <div className="flex items-start gap-2">
      <span className="text-warning animate-pulse mt-[2px]">✶</span>
      <div className="prose-sm prose-warning">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </div>
  )
}

function StatusRow({ text, spinner, italic }: { text?: string; spinner?: boolean; italic?: boolean }) {
  if (!text) {
return null
}
  if (spinner) {
    return (
      <div className="text-xs">
        <Shimmer duration={3}>{text}</Shimmer>
      </div>
    )
  }
  return (
    <div className="text-xs text-muted-foreground">
      <span className={italic ? 'italic' : ''}>{text}</span>
    </div>
  )
}

export function ToolCard({ item }: { item: ToolItem }) {
  const hasResult = item.status === 'result'
  const toolState = hasResult ? 'output-available' as const : 'input-available' as const

  const headerTitle = useMemo(() => {
    const meta = item.metadata
    const sum = meta && typeof meta === 'object' ? String(meta.summary || '') : ''
    if (sum && sum.trim().length > 0) {
return sum.trim()
}
    return item.tool
  }, [item.tool, item.metadata])

  const headerPreview = useMemo(() => {
    const meta = item.metadata
    const sum = meta && typeof meta === 'object' ? String(meta.summary || '') : ''
    if (sum && sum.trim().length > 0) {
return undefined
}
    return formatArgsPreview(item.input || '', 80) || undefined
  }, [item.input, item.metadata])

  const richBody = useMemo(() => renderMetadata(item.metadata, item.output || ''), [item.metadata, item.output])
  const parsedInput = useMemo(() => {
    if (!item.input) {
return undefined
}
    try {
 return JSON.parse(item.input) 
} catch {
 return undefined 
}
  }, [item.input])

  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0">
        <Tool>
          <ToolHeader
            type={`tool-${item.tool}`}
            state={toolState}
            title={headerTitle}
            preview={headerPreview}
          />
          <ToolContent>
            {parsedInput && <ToolInput input={parsedInput} />}
            {richBody ? (
              <div className="space-y-2">
                <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Result</h4>
                {richBody}
              </div>
            ) : hasResult && item.output ? (
              <ToolOutput
                output={item.output}
                errorText={item.metadata?.display_type === 'error' ? item.metadata?.summary || undefined : undefined}
              />
            ) : null}
          </ToolContent>
        </Tool>
      </div>
    </div>
  )
}

const COLLAPSIBLE_DISPLAY_TYPES = new Set(['diff', 'file_write', 'file_content', 'search_results', 'command'])

function ApprovalCard({ item, onDecision, queuePosition, queueTotal }: { item: ApprovalItem; onDecision?: (request_id: string, value: 'yes' | 'always' | 'no') => void; queuePosition?: number; queueTotal?: number }) {
  const meta = item.metadata
  const summary = meta && typeof meta === 'object' && typeof meta.summary === 'string' ? meta.summary : ''
  const richBody = renderMetadata(meta, item.argumentsText || '')
  const [expanded, setExpanded] = useState(false)
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), [])

  // Header
  const displayType = meta && typeof meta === 'object' ? meta.display_type : undefined
  const metaInner = meta && typeof meta === 'object' ? meta.metadata : undefined
  let headerSuffix: React.ReactNode = null
  if ((displayType === 'file_write' || displayType === 'diff') && metaInner && typeof metaInner.file_path === 'string' && metaInner.file_path) {
    headerSuffix = <span className="font-mono text-xs text-warning/90"> — {metaInner.file_path}</span>
  } else if (displayType === 'command' && metaInner && typeof metaInner.command === 'string' && metaInner.command) {
    const cmd = metaInner.command
    const truncated = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd
    headerSuffix = <span className="font-mono text-xs text-warning/90"> — {truncated}</span>
  }

  const canCollapse = !!richBody && typeof displayType === 'string' && COLLAPSIBLE_DISPLAY_TYPES.has(displayType)
  const showQueueBadge = typeof queueTotal === 'number' && queueTotal > 1

  return (
    <div className="rounded-md border border-warning bg-secondary p-3 relative">
      {showQueueBadge ? (
        <div className="absolute top-2 right-2 text-[10px] uppercase tracking-wide text-warning bg-warning/10 border border-warning/40 rounded px-1.5 py-0.5">
          {queuePosition} of {queueTotal} pending
        </div>
      ) : null}
      <div className="text-sm font-semibold text-warning pr-24">
        Approve {item.tool}
        {headerSuffix}
      </div>
      {summary ? <div className="text-xs text-muted-foreground mt-0.5">{summary}</div> : null}
      <div className="mt-2">
        {richBody ? (
          <>
            <div className={`${expanded ? 'max-h-none' : 'max-h-[40vh]'} overflow-auto`}>
              {richBody}
            </div>
            {canCollapse ? (
              <div className="mt-1 flex justify-end">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={toggleExpanded}
                >
                  {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
                  {expanded ? 'Collapse' : 'Show all'}
                </button>
              </div>
            ) : null}
          </>
        ) : item.argumentsText ? (
          <CodeBlock code={item.argumentsText} language="json" />
        ) : (
          <div className="text-xs text-muted-foreground">No parameters</div>
        )}
      </div>
      <div className="mt-3 flex gap-2 justify-end">
        <button className="px-3 py-1.5 text-xs rounded-md border border-destructive text-destructive bg-transparent hover:bg-destructive/20" onClick={() => onDecision && onDecision(item.request_id, 'no')}>Reject</button>
        <button className="px-3 py-1.5 text-xs rounded-md border border-primary text-primary bg-transparent hover:bg-muted" onClick={() => onDecision && onDecision(item.request_id, 'always')}>Always</button>
        <button className="px-3 py-1.5 text-xs rounded-md bg-primary hover:brightness-110 text-primary-foreground" onClick={() => onDecision && onDecision(item.request_id, 'yes')}>Approve Once</button>
      </div>
    </div>
  )
}

function PlanCard({ item, onDecision }: { item: PlanItem; onDecision?: (approved: boolean) => void }) {
  return (
    <Plan defaultOpen>
      <PlanHeader>
        <div>
          <PlanTitle>{item.title}</PlanTitle>
          {item.description ? <PlanDescription>{item.description}</PlanDescription> : null}
        </div>
      </PlanHeader>
      <PlanContent>
        <ol className="space-y-2 list-none">
          {item.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircleIcon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">{step.title}</div>
                {step.description ? <div className="text-xs text-muted-foreground">{step.description}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </PlanContent>
      <PlanFooter className="justify-end gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded-md border border-destructive text-destructive bg-transparent hover:bg-destructive/20"
          onClick={() => onDecision?.(false)}
        >
          Reject
        </button>
        <button
          className="px-3 py-1.5 text-xs rounded-md bg-primary hover:brightness-110 text-primary-foreground"
          onClick={() => onDecision?.(true)}
        >
          Approve Plan
        </button>
      </PlanFooter>
    </Plan>
  )
}

export function formatArgsPreview(args: string, maxLen: number) {
  if (!args) {
return ''
}
  let parsed: any
  try {
 parsed = JSON.parse(args) 
} catch {}
  let text: string
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const parts: string[] = []
    Object.entries(parsed).forEach(([k, v]) => {
      let vs: string
      if (typeof v === 'string') {
vs = `"${v}"`
} else if (typeof v === 'number' || typeof v === 'boolean') {
vs = String(v)
} else {
        try {
 vs = JSON.stringify(v) 
} catch {
 vs = String(v) 
}
      }
      parts.push(`${k}: ${vs}`)
    })
    text = parts.join(', ')
  } else {
    text = args.replace(/\s+/g, ' ').trim()
  }
  if (text.length > maxLen) {
return `${text.slice(0, maxLen - 3)  }...`
}
  return text
}

function renderMetadata(meta: any, fallbackText: string): React.ReactNode | null {
  if (meta && typeof meta === 'object' && meta.display_type) {
    const dt = meta.display_type as string
    if (dt === 'diff') {
return diffView(linesFromDiff(meta))
}
    if (dt === 'table') {
return tableView(meta)
}
    if (dt === 'file_write') {
return codeBlockView((meta.value as string) || fallbackText, meta.metadata?.language)
}
    if (dt === 'command') {
return commandView(meta, fallbackText)
}
    if (dt === 'file_content') {
return fileContentView(meta, fallbackText)
}
    if (dt === 'directory_listing') {
return directoryListingView(meta, fallbackText)
}
    if (dt === 'search_results') {
return searchResultsView(meta, fallbackText)
}
    if (dt === 'web_content') {
return webContentView(meta, fallbackText)
}
    if (dt === 'error') {
return errorView(meta, fallbackText)
}
    if (typeof meta.preview === 'string' && meta.preview.trim().length > 0) {
return codeBlockView(meta.preview)
}
  }
  return null
}

function linesFromDiff(metadata: any): string[] {
  const v = metadata?.value
  const acc: string[] = []
  if (v && typeof v === 'object' && Array.isArray(v.diff_lines)) {
    for (const s of v.diff_lines) {
if (typeof s === 'string') {
acc.push(s)
}
}
  }
  return acc
}

function diffView(lines: string[]) {
  const content = lines.join('\n')
  return <CodeBlock code={content} language="diff" />
}

function tableView(metadata: any) {
  const t = metadata?.table || {}
  const cols: string[] = Array.isArray(t.columns) ? t.columns.map((c: any) => (c && typeof c === 'object' ? c.title : '')).filter(Boolean) : []
  const rows: string[][] = Array.isArray(t.rows) ? t.rows.map((r: any) => Array.isArray(r) ? r.map((e: any) => (e == null ? '' : String(e))) : []).filter((r: any) => r.length) : []
  return (
    <div className="overflow-x-auto rounded-md border bg-muted/50">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            {cols.map((c, i) => <th key={i} className="text-left font-semibold pr-4 pb-1 px-3 pt-2">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((cell, j) => <td key={j} className="pr-4 py-1 px-3 whitespace-nowrap">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function codeBlockView(content: string, language?: string) {
  return <CodeBlock code={content} language={(language || 'text') as any} />
}

function commandView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  let command = plainOutput || ''
  if (typeof meta?.command === 'string') {
command = meta.command
}
  let output = ''
  const value = metadata?.value
  if (typeof value === 'string' && value.trim().length > 0) {
output = value
} else if (typeof metadata?.preview === 'string' && metadata.preview.trim().length > 0) {
output = metadata.preview
} else {
    const stdout = meta?.stdout
    const stderr = meta?.stderr
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
parts.push(stdout)
}
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
parts.push(`[stderr]\n${  stderr}`)
}
    if (parts.length) {
output = parts.join('\n')
}
    if (!output && plainOutput && plainOutput.trim().length > 0) {
output = plainOutput
}
  }
  const status: string[] = []
  if (typeof meta?.success === 'boolean') {
status.push(meta.success ? 'success' : 'failed')
}
  if (typeof meta?.exit_code === 'number') {
status.push(`exit ${  String(meta.exit_code)}`)
}
  if (typeof meta?.wall_time_ms === 'number') {
status.push(`${meta.wall_time_ms  }ms`)
}
  if (typeof meta?.was_truncated === 'boolean' && meta.was_truncated) {
    const charsTruncated = meta?.chars_truncated
    status.push(typeof charsTruncated === 'number' ? `${charsTruncated.toLocaleString()} chars truncated` : 'truncated')
  }
  if (typeof meta?.has_stderr === 'boolean' && meta.has_stderr) {
status.push('stderr captured')
}
  const statusColor = meta?.success === false ? 'text-destructive' : 'text-muted-foreground'
  return (
    <div className="space-y-2">
      <CodeBlock code={`$ ${  String(command)}`} language="bash" />
      {status.length ? <div className={['text-[12px]', statusColor].join(' ')}>{status.join(' \u00b7 ')}</div> : null}
      {output.trim().length ? <CodeBlock code={output.trimEnd()} language="text" /> : null}
    </div>
  )
}

function fileContentView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  if (typeof meta?.total_file_lines === 'number') {
stats.push(`${meta.total_file_lines.toLocaleString()} lines total`)
}
  if (typeof meta?.lines_truncated_count === 'number' && meta.lines_truncated_count > 0) {
stats.push(`${meta.lines_truncated_count} long lines truncated`)
}
  if (typeof meta?.start_line === 'number' && typeof meta?.end_line === 'number') {
    stats.push(`showing L${meta.start_line}-${meta.end_line}`)
  }
  const lang = meta?.language || guessLanguage(meta?.file_path) || 'text'
  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-muted-foreground">{stats.join(' \u00b7 ')}</div> : null}
      <CodeBlock code={preview} language={lang as any} showLineNumbers={!!meta?.start_line} />
    </div>
  )
}

function directoryListingView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  if (typeof meta?.total_entries === 'number') {
stats.push(`${meta.total_entries.toLocaleString()} entries`)
}
  if (typeof meta?.file_count === 'number') {
stats.push(`${meta.file_count} files`)
}
  if (typeof meta?.dir_count === 'number') {
stats.push(`${meta.dir_count} dirs`)
}
  if (typeof meta?.symlink_count === 'number' && meta.symlink_count > 0) {
stats.push(`${meta.symlink_count} symlinks`)
}
  if (typeof meta?.was_truncated === 'boolean' && meta.was_truncated) {
stats.push('truncated')
}

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-muted-foreground">{stats.join(' \u00b7 ')}</div> : null}
      <CodeBlock code={preview} language="text" />
    </div>
  )
}

function searchResultsView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  if (typeof meta?.files_with_matches === 'number') {
stats.push(`${meta.files_with_matches} files with matches`)
}
  if (typeof meta?.files_searched === 'number') {
stats.push(`${meta.files_searched.toLocaleString()} files searched`)
}
  if (typeof meta?.elapsed_ms === 'number') {
stats.push(`${meta.elapsed_ms}ms`)
}
  if (typeof meta?.timed_out === 'boolean' && meta.timed_out) {
stats.push('timed out')
}
  if (typeof metadata?.truncated === 'boolean' && metadata.truncated) {
stats.push('truncated')
}

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-muted-foreground">{stats.join(' \u00b7 ')}</div> : null}
      <CodeBlock code={preview} language="text" />
    </div>
  )
}

function webContentView(metadata: any, plainOutput: string) {
  const meta = metadata?.metadata || {}
  const preview = typeof metadata?.preview === 'string' ? metadata.preview : plainOutput
  const stats: string[] = []
  if (typeof meta?.title === 'string' && meta.title.trim()) {
stats.push(meta.title)
}
  if (typeof meta?.elapsed_ms === 'number') {
stats.push(`${meta.elapsed_ms}ms`)
}
  if (typeof meta?.link_count === 'number') {
stats.push(`${meta.link_count} links`)
}
  if (typeof meta?.links_truncated === 'boolean' && meta.links_truncated && typeof meta?.total_links === 'number') {
    stats.push(`(${meta.total_links} total)`)
  }

  return (
    <div className="space-y-2">
      {stats.length ? <div className="text-[12px] text-muted-foreground">{stats.join(' \u00b7 ')}</div> : null}
      <CodeBlock code={preview} language="text" />
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
        <div className="text-[12px] text-destructive font-medium">
          {summary || errorType}
        </div>
      ) : null}
      <div className="w-full overflow-x-auto p-2 rounded border border-destructive/30 bg-destructive/10">
        <pre className="whitespace-pre-wrap text-[12px] text-destructive"><code>{preview}</code></pre>
      </div>
    </div>
  )
}

/** Guess language from file extension for syntax highlighting */
function guessLanguage(filePath?: string): string | undefined {
  if (!filePath) {
return undefined
}
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
    java: 'java', kt: 'kotlin', swift: 'swift', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    xml: 'xml', svg: 'xml', dockerfile: 'dockerfile',
  }
  return ext ? map[ext] : undefined
}
