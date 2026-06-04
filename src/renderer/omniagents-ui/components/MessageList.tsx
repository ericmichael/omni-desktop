import { AppRenderer } from '@mcp-ui/client'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { motion } from 'framer-motion'
import { CheckCircleIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, Maximize2Icon, Minimize2Icon, PaperclipIcon,ThumbsDownIcon, ThumbsUpIcon } from 'lucide-react'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { getGreeting } from '@/renderer/omniagents-ui/greeting'
import { useRPCClient } from '@/renderer/omniagents-ui/rpc-context'

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

export type { ApprovalItem, ArtifactItem, ArtifactMcpUi, Attachment, ChatMessage, MessageItem, PlanItem, ToolItem } from '@/shared/chat-types'
import type { ApprovalItem, ArtifactItem, ArtifactMcpUi, Attachment, ChatMessage, MessageItem, PlanItem, ToolItem } from '@/shared/chat-types'

// Portal target for maximized artifacts. App.tsx provides the chat-column
// element so a maximized artifact can absolute-position-fill the pane between
// the header and the input bar (i.e. cover the message list, but not the
// sidebar/header). Null falls back to inline rendering.
const ArtifactPortalContext = createContext<HTMLElement | null>(null)

export function ArtifactPortalProvider({ target, children }: { target: HTMLElement | null; children: React.ReactNode }) {
  return <ArtifactPortalContext.Provider value={target}>{children}</ArtifactPortalContext.Provider>
}

export function MessageList({ items, greeting: greetingProp, statusText, thinking, statusSpinner, preambleText, welcomeText, onApprovalDecision, pendingPlan, onPlanDecision, statusItalic, onReaction, currentRunId, toolStatusText, onSubmitMessage, onStageContext }:
  { items: MessageItem[]; greeting?: string; statusText?: string; thinking?: boolean; statusSpinner?: boolean; preambleText?: string; welcomeText?: string; onApprovalDecision?: (request_id: string, value: 'yes' | 'always' | 'no', kind?: 'function' | 'mcp') => void; pendingPlan?: PlanItem | null; onPlanDecision?: (approved: boolean) => void; statusItalic?: boolean; onReaction?: (type: 'like' | 'dislike', text?: string) => void; currentRunId?: string; toolStatusText?: string; onSubmitMessage?: (text: string) => void | Promise<void>; onStageContext?: (source: string, text: string) => void }) {
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
  // Tools may opt out of the conversation log by attaching
  // ``ui_metadata.hidden = true`` on their RichToolOutput (e.g.
  // ``bash_status`` polls, no-op ``bash_kill`` results). The omniagents
  // web/Ink backends drop them before grouping so they don't render as
  // chat cards and don't inflate activity-group counts — match that
  // here so the docked panels stay the only surface for those signals.
  const visibleItems = useMemo(
    () => items.filter((it) => !(it.type === 'tool' && (it as ToolItem).metadata?.hidden === true)),
    [items],
  )
  const displayItems = useMemo(() => groupItems(visibleItems, currentRunId, !!thinking), [visibleItems, currentRunId, thinking])
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
return <MessageBubble key={i} index={i} role={(m as ChatMessage).role} content={(m as ChatMessage).content} attachments={(m as ChatMessage).attachments} stagedContext={(m as ChatMessage).staged_context} reactions={reactions} onReact={handleReaction} feedbackIndex={feedbackIndex} onFeedbackSubmit={handleFeedbackSubmit} onFeedbackDismiss={handleFeedbackDismiss} />
}
            if (m.type === 'tool') {
return <ToolCard key={(m as ToolItem).call_id || i} item={m as ToolItem} />
}
            if (m.type === 'artifact') {
return <InlineArtifact key={(m as ArtifactItem).artifact_id || i} item={m as ArtifactItem} onSubmitMessage={onSubmitMessage} onStageContext={onStageContext} />
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

/**
 * Compact "📎 context attached" affordance shown next to a user message
 * that carried MCP-Apps staged context. Clicking it expands to show the
 * full text of each entry so the user can see exactly what extra context
 * the model received on this turn.
 */
function StagedContextRibbon({ entries }: { entries: NonNullable<ChatMessage['staged_context']> }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => setExpanded((v) => !v), [])
  const summary = entries.length === 1
    ? entries[0]?.text.split(/\r?\n/)[0]?.slice(0, 60) ?? ''
    : `${entries.length} context blocks attached`
  return (
    <div className="w-full flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        📎 {expanded ? 'Hide' : entries.length === 1 ? summary : summary}
      </button>
      {expanded ? (
        <div className="w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-[12px] text-muted-foreground space-y-2">
          {entries.map((c) => (
            <pre key={c.source} className="whitespace-pre-wrap break-words font-sans">
              {c.text}
            </pre>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MessageBubble({ index, role, content, attachments, stagedContext, reactions, onReact, feedbackIndex, onFeedbackSubmit, onFeedbackDismiss }: { index: number; role: ChatMessage['role']; content: string; attachments?: Attachment[]; stagedContext?: ChatMessage['staged_context']; reactions?: Record<number, 'like' | 'dislike' | undefined>; onReact?: (index: number, type: 'like' | 'dislike') => void; feedbackIndex?: number; onFeedbackSubmit?: (index: number, text: string) => void; onFeedbackDismiss?: () => void }) {
  const [feedbackText, setFeedbackText] = useState('')
  const showFeedback = feedbackIndex === index
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="flex min-w-0 max-w-[85%] flex-col items-end space-y-2 sm:max-w-[70%]">
          {attachments && attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full justify-end">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          {stagedContext && stagedContext.length > 0 ? (
            <StagedContextRibbon entries={stagedContext} />
          ) : null}
          <div className="max-w-full overflow-hidden rounded-[18px] bg-primary text-primary-foreground px-4 py-3 text-sm">
            <MessageResponse>{content}</MessageResponse>
          </div>
        </div>
      </div>
    )
  }
  if (role === 'system') {
    return (
      <div className="flex justify-start">
        <div className="flex w-full min-w-0 max-w-full flex-col items-start">
          {attachments && attachments.length > 0 ? (
            <div className="mb-1 flex flex-wrap gap-2 w-full">
              {attachments.map((att, i) => (
                <AttachmentChip key={i} attachment={att} />
              ))}
            </div>
          ) : null}
          <div className="max-w-full overflow-hidden rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground">
            <MessageResponse>{content}</MessageResponse>
          </div>
        </div>
      </div>
    )
  }
  // assistant
  return (
    <div className="flex justify-start">
      <div className="flex w-full min-w-0 max-w-full flex-col items-start">
        {attachments && attachments.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-2 w-full">
            {attachments.map((att, i) => (
              <AttachmentChip key={i} attachment={att} />
            ))}
          </div>
        ) : null}
        <div className="flex min-w-0 max-w-full flex-col items-start overflow-hidden">
          <div className="min-w-0 max-w-full overflow-hidden text-sm text-foreground">
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

function InlineArtifact({ item, onSubmitMessage, onStageContext }: { item: ArtifactItem; onSubmitMessage?: (text: string) => void | Promise<void>; onStageContext?: (source: string, text: string) => void }) {
  const [copied, setCopied] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const portalTarget = useContext(ArtifactPortalContext)
  const mode = String(item.mode || 'markdown')
  // Copy makes sense only for textual artifacts. `mcp_ui` has empty content;
  // `html` and `image` would copy raw markup / URL, which isn't useful here.
  const copyable = mode !== 'mcp_ui' && mode !== 'html' && mode !== 'image'

  const handleCopy = useCallback(() => {
    try {
 navigator.clipboard.writeText(item.content)
} catch {}
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [item.content])

  const toggleMaximized = useCallback(() => setMaximized((v) => !v), [])

  useEffect(() => {
    if (!maximized) {
return
}
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMaximized(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [maximized])

  const canPortal = maximized && portalTarget !== null

  const artifact = (
    <Artifact className={canPortal ? 'h-full w-full shadow-lg' : undefined}>
      <ArtifactHeader>
        <ArtifactTitle>{item.title || 'Artifact'}</ArtifactTitle>
        <ArtifactActions>
          {copyable ? (
            <ArtifactAction
              tooltip={copied ? 'Copied!' : 'Copy'}
              icon={CopyIcon}
              onClick={handleCopy}
            />
          ) : null}
          <ArtifactAction
            tooltip={maximized ? 'Restore' : 'Maximize'}
            icon={maximized ? Minimize2Icon : Maximize2Icon}
            onClick={toggleMaximized}
          />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className={canPortal ? 'flex' : undefined}>
        <InlineArtifactBody item={item} maximized={canPortal} onSubmitMessage={onSubmitMessage} onStageContext={onStageContext} />
      </ArtifactContent>
    </Artifact>
  )

  if (canPortal) {
    // Toggling maximize unmounts/remounts the artifact body — iframe-backed
    // modes (mcp_ui, html) reload on each toggle. Acceptable since users
    // typically maximize before interacting, not mid-flow.
    return createPortal(
      <div className="absolute inset-0 z-20 flex bg-background/95 p-3">
        {artifact}
      </div>,
      portalTarget,
    )
  }

  return (
    <div className="flex justify-start" data-artifact-id={item.artifact_id || undefined}>
      <div className="w-full min-w-0 max-w-full overflow-hidden">
        {artifact}
      </div>
    </div>
  )
}

function InlineArtifactBody({ item, maximized, onSubmitMessage, onStageContext }: { item: ArtifactItem; maximized?: boolean; onSubmitMessage?: (text: string) => void | Promise<void>; onStageContext?: (source: string, text: string) => void }) {
  const mode = String(item.mode || 'markdown')

  if (mode === 'mcp_ui' && item.mcp_ui) {
    return <McpUiSurface payload={item.mcp_ui} sessionId={item.session_id} artifactId={item.artifact_id} maximized={maximized} onSubmitMessage={onSubmitMessage} onStageContext={onStageContext} />
  }

  if (mode === 'markdown') {
    return (
      <Markdown className="prose-sm" highlight inheritTextColor>
        {item.content}
      </Markdown>
    )
  }

  if (mode === 'html') {
    return <InlineHtmlPreview content={item.content} maximized={maximized} />
  }

  if (mode === 'image') {
    return <img src={item.content} alt={item.title || 'artifact'} className={maximized ? 'mx-auto max-h-full max-w-full rounded' : 'max-w-full rounded'} />
  }

  // plain text / unknown
  return <pre className="whitespace-pre-wrap break-words text-sm">{item.content}</pre>
}

function InlineHtmlPreview({ content, maximized }: { content: string; maximized?: boolean }) {
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
      style={{ width: '100%', height: maximized ? '100%' : height, border: 'none', borderRadius: 6, background: 'var(--color-background)' }}
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
    <div className="flex min-w-0 max-w-full items-start gap-2 overflow-hidden">
      <span className="text-warning animate-pulse mt-[2px]">✶</span>
      <div className="prose-sm prose-warning min-w-0 max-w-full overflow-hidden">
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

/**
 * Host identity advertised to MCP-Apps guests so apps can branch on host
 * (e.g. style differently for ChatGPT vs. Claude Desktop vs. us).
 */
const MCP_UI_HOST_INFO = { name: 'Omni Code Launcher', version: '1.0.0' } as const

/**
 * Host capability declaration. Each present key signals support; empty
 * objects ``{}`` are the spec's "yes, present" shape for boolean-style
 * capabilities. Anything not listed here, the guest must assume we don't
 * support — Prefab's renderer keys feature visibility off this.
 *
 *   • ``openLinks``      — we forward ``ui/open-link`` via ``handleOpenLink``
 *   • ``serverTools``    — we forward ``tools/call`` to omniagents
 *   • ``serverResources``— we forward ``resources/read`` to omniagents
 *   • ``message``        — we accept ``ui/message`` when ``onSubmitMessage``
 *                          is wired (driven by the chat's submit path)
 */
const MCP_UI_HOST_CAPABILITIES = {
  openLinks: {},
  serverTools: {},
  serverResources: {},
  // ``message`` declares which content-block modalities we accept from
  // ``ui/message`` requests. We only forward ``text`` blocks into the
  // chat's submit path today.
  message: { text: {} },
  // ``updateModelContext`` — same modality set as ``message``. The host
  // stashes the content in a session-local staged-context buffer that
  // gets prepended to the next user prompt (see ``App.tsx#handleSubmit``).
  updateModelContext: { text: {} },
} as const

/**
 * Build the MCP-Apps sandbox proxy URL. Returns a separate-origin URL
 * under Electron (``mcp-sandbox://``) and a same-origin route in browser
 * mode. See ``src/main/index.ts`` and ``src/server/index.ts``.
 */
function getMcpSandboxUrl(): URL {
  const isElectron = typeof window !== 'undefined' && 'electron' in window
  if (isElectron) {
    return new URL('mcp-sandbox://app/index.html')
  }
  return new URL(`${window.location.origin}/mcp-sandbox/index.html`)
}

/**
 * Build the HTML payload to hand to AppRenderer. MCP-Apps UI resources come
 * in two flavors: ``text/html;profile=mcp-app`` (HTML directly) and
 * ``text/uri-list`` (URL to embed). For uri-list we synthesize a minimal
 * HTML wrapper that iframes the target URL — the sandbox CSP allows
 * ``frame-src https: http:`` so the embed loads cross-origin.
 */
function resolveMcpUiHtml(inner: NonNullable<ArtifactMcpUi['resource']>['resource']): string {
  if (!inner) {
return ''
}
  const mime = String(inner.mimeType || '').toLowerCase()
  const raw = typeof inner.text === 'string' ? inner.text : inner.blob ? safeAtob(inner.blob) : ''
  if (!raw) {
return ''
}
  if (mime.includes('uri-list') || /^https?:\/\//i.test(raw.trim())) {
    const url = raw.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? ''
    if (!url) {
return ''
}
    // Wrapper HTML for ``externalUrl`` content. The wrapper sits between
    // our proxy iframe and the actual external page (three iframes deep
    // total). Without the bridging script below the external page's
    // ``window.parent.postMessage`` calls die at the wrapper — that's
    // what breaks ``SendMessage`` / ``UpdateContext`` / ``CallTool``
    // from inside a Prefab page served via ``text/uri-list``. We forward
    // everything bidirectionally so MCP-Apps actions reach the host.
    return `<!doctype html><html><body style="margin:0;height:100vh"><iframe id="inner" src="${escapeHtml(url)}" style="border:0;width:100%;height:100%" sandbox="allow-scripts allow-forms allow-popups allow-same-origin"></iframe><script>(function(){var i=document.getElementById('inner');window.addEventListener('message',function(e){if(e.source===window.parent&&i.contentWindow){i.contentWindow.postMessage(e.data,'*');}else if(i&&e.source===i.contentWindow){window.parent.postMessage(e.data,'*');}});})();</script></body></html>`
  }
  return raw
}

function safeAtob(b: string): string {
  try {
 return atob(b)
} catch {
 return ''
}
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/**
 * Render an MCP-Apps UI resource as an artifact-body surface. The payload
 * is stashed by omniagents (``omniagents/core/agents/mcp_ui.py``) when an
 * MCP server returns a ``text/html;profile=mcp-app`` / ``text/uri-list``
 * content block; ``use-chat-session`` then turns the ``tool_result``
 * metadata into a standalone ``ArtifactItem`` so it gets full-width
 * framing rather than being collapsed into an activity group with other
 * tool cards. The mcp-ui ``<AppRenderer>`` runs inside our sandboxed
 * proxy iframe and routes ``tools/call`` / ``resources/read`` postMessage
 * requests back to omniagents' ``mcp.*`` server functions out-of-band, per
 * the MCP Apps spec.
 */
function McpUiSurface({ payload, sessionId, artifactId, maximized, onSubmitMessage, onStageContext }: { payload: ArtifactMcpUi; sessionId?: string; artifactId?: string; maximized?: boolean; onSubmitMessage?: (text: string) => void | Promise<void>; onStageContext?: (source: string, text: string) => void }) {
  const rpc = useRPCClient()
  const serverName = payload.server_name
  // Stable source key per artifact: re-stages from the same MCP UI replace
  // the prior entry, per the spec's "overwrite previous context" rule.
  const stageSource = artifactId ? `mcp_ui:${artifactId}` : `mcp_ui:${payload.tool_name}`

  // Resolve HTML for ``<AppRenderer>``. The inline case extracts from
  // ``payload.resource.resource.text``; the resource-URI case
  // (FastMCP/Prefab) fetches a shared renderer over RPC. Either way
  // the result is a string of HTML.
  const inlineHtml = useMemo(
    () => resolveMcpUiHtml(payload.resource?.resource),
    [payload.resource?.resource],
  )
  const [fetchedHtml, setFetchedHtml] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  useEffect(() => {
    if (!payload.resource_uri || !serverName) {
return
}
    let cancelled = false
    setFetchError(null)
    setFetchedHtml(null)
    rpc
      .mcpReadResource(serverName, payload.resource_uri, sessionId)
      .then((res) => {
        if (cancelled) {
return
}
        const contents = Array.isArray(res.contents) ? res.contents : []
        // Find the first text/html entry. ``contents[]`` items are
        // serialized MCP ``TextResourceContents`` / ``BlobResourceContents``;
        // the renderer is text.
        let html: string | null = null
        for (const c of contents as Array<Record<string, unknown>>) {
          const text = typeof c.text === 'string' ? (c.text as string) : null
          if (text) {
            html = text
            break
          }
          const blob = typeof c.blob === 'string' ? (c.blob as string) : null
          if (blob) {
            try {
              html = atob(blob)
              break
            } catch {
              // continue
            }
          }
        }
        if (html) {
          setFetchedHtml(html)
        } else {
          setFetchError('UI resource returned no HTML content')
        }
      })
      .catch((err: Error) => {
        if (cancelled) {
return
}
        setFetchError(err.message || 'Failed to load UI resource')
      })
    return () => {
      cancelled = true
    }
  }, [rpc, serverName, payload.resource_uri, sessionId])

  const html = fetchedHtml ?? inlineHtml

  const toolInput = useMemo(() => {
    const inp = payload.tool_input
    if (inp && typeof inp === 'object') {
return inp as Record<string, unknown>
}
    return undefined
  }, [payload.tool_input])

  const toolResult = useMemo<CallToolResult | undefined>(() => {
    // FastMCP/Prefab path: synthesize a CallToolResult from the structured
    // content so the shared renderer (e.g. Prefab's React bundle) gets the
    // per-call payload it needs. ``content`` is empty because Prefab tools
    // put everything in structuredContent.
    if (payload.structured_content !== undefined && payload.structured_content !== null) {
      return {
        content: [],
        structuredContent: payload.structured_content as Record<string, unknown>,
      } as CallToolResult
    }
    if (!payload.tool_output) {
return undefined
}
    try {
      const parsed = JSON.parse(payload.tool_output)
      if (parsed && typeof parsed === 'object' && 'content' in parsed) {
        return parsed as CallToolResult
      }
    } catch {
      // ignore — not all tool outputs are JSON CallToolResult
    }
    return undefined
  }, [payload.structured_content, payload.tool_output])

  const sandboxUrl = useMemo(() => getMcpSandboxUrl(), [])

  const handleCallTool = useCallback(
    async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const res = await rpc.mcpCallTool(serverName, params.name, params.arguments ?? {}, sessionId)
      return (res.result ?? { content: [] }) as CallToolResult
    },
    [rpc, serverName, sessionId],
  )

  const handleReadResource = useCallback(
    async (params: { uri: string }): Promise<ReadResourceResult> => {
      const res = await rpc.mcpReadResource(serverName, params.uri, sessionId)
      return { contents: res.contents } as ReadResourceResult
    },
    [rpc, serverName, sessionId],
  )

  const handleOpenLink = useCallback(async (params: { url: string }) => {
    const url = params.url || ''
    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
    return {}
  }, [])

  // ``ui/update-model-context`` — guest stages content to be included in
  // the next user turn without triggering a response. AppRenderer doesn't
  // expose a dedicated prop for this; it routes via ``onFallbackRequest``.
  // We extract text content and stash via ``onStageContext``; ``App.tsx``'s
  // ``handleSubmit`` prepends staged context to the next prompt.
  const handleFallbackRequest = useCallback(
    async (
      request: { method?: string; params?: { content?: Array<{ type?: string; text?: string }> } },
    ): Promise<Record<string, unknown>> => {
      if (request?.method === 'ui/update-model-context' && onStageContext) {
        const text = (request.params?.content ?? [])
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('\n\n')
          .trim()
        onStageContext(stageSource, text)
        return {}
      }
      // Unknown method — surface as a host-side McpError so the guest can
      // distinguish "not supported" from a transport failure.
      throw new McpError(ErrorCode.MethodNotFound, `Unsupported MCP-UI method: ${request?.method ?? '<missing>'}`)
    },
    [onStageContext, stageSource],
  )

  // ``ui/message`` — guest asks the host to send a chat message on behalf
  // of the user. Prefab's ``SendMessage`` action ("Ask AI" button in the
  // hitchhikers-guide demo) maps to this. We extract the text parts and
  // route them through the chat's normal submit path so the agent sees
  // a regular user turn.
  const handleMessage = useCallback(
    async (params: { content?: Array<{ type?: string; text?: string }> }): Promise<{ isError?: boolean }> => {
      if (!onSubmitMessage) {
        return { isError: true }
      }
      const text = (params.content ?? [])
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n\n')
        .trim()
      if (!text) {
        return { isError: true }
      }
      try {
        await onSubmitMessage(text)
        return {}
      } catch {
        return { isError: true }
      }
    },
    [onSubmitMessage],
  )

  if (fetchError) {
    return (
      <pre className="whitespace-pre-wrap break-words text-sm text-destructive">
        Failed to load MCP UI resource: {fetchError}
      </pre>
    )
  }
  if (!serverName) {
    return (
      <pre className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        MCP UI payload missing server reference.
      </pre>
    )
  }
  if (!html) {
    // Resource-URI path still fetching, or no HTML at all.
    if (payload.resource_uri) {
      return <div className="px-3 py-2 text-xs text-muted-foreground">Loading MCP UI resource…</div>
    }
    return (
      <pre className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        MCP UI payload missing HTML content.
      </pre>
    )
  }

  return (
    // The iframe is forced to ``!w-full !h-full`` so it ignores the
    // pixel width/height AppFrame keeps writing in response to the
    // guest's ``size-changed`` notifications. The wrapper owns the
    // sizing (full width × 70vh cap) and the *single* scrollbar lives
    // inside the iframe, on the guest's own scrolling root — same as
    // every other webview-style host. Avoid stacking outer + inner
    // scrollbars by keeping the wrapper ``overflow-hidden``.
    <div
      className="relative w-full overflow-hidden [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!max-w-full [&_iframe]:!max-h-full [&_iframe]:!block"
      style={maximized ? { width: '100%', height: '100%' } : { height: '70vh', minHeight: 320 }}
    >
      <AppRenderer
        toolName={payload.tool_name}
        sandbox={{ url: sandboxUrl }}
        html={html}
        toolInput={toolInput}
        toolResult={toolResult}
        hostInfo={MCP_UI_HOST_INFO}
        hostCapabilities={MCP_UI_HOST_CAPABILITIES}
        onCallTool={handleCallTool}
        onReadResource={handleReadResource as never}
        onOpenLink={handleOpenLink}
        onMessage={onSubmitMessage ? handleMessage : undefined}
        onFallbackRequest={handleFallbackRequest as never}
      />
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

  const richBody = useMemo(
    () => renderMetadata(item.metadata, item.output || ''),
    [item.metadata, item.output],
  )
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
      <div className="w-full min-w-0 max-w-full overflow-hidden">
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

function ApprovalCard({ item, onDecision, queuePosition, queueTotal }: { item: ApprovalItem; onDecision?: (request_id: string, value: 'yes' | 'always' | 'no', kind?: 'function' | 'mcp') => void; queuePosition?: number; queueTotal?: number }) {
  const meta = item.metadata
  const summary = meta && typeof meta === 'object' && typeof meta.summary === 'string' ? meta.summary : ''
  const richBody = renderMetadata(meta, item.argumentsText || '')
  const [expanded, setExpanded] = useState(false)
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), [])
  const isMcp = item.kind === 'mcp'

  // Header. MCP approvals identify the hosted server via ``server_label``
  // and have no ``always_approve`` affordance (omniagents 0.16 intentionally
  // omits it for MCP).
  const displayType = meta && typeof meta === 'object' ? meta.display_type : undefined
  const metaInner = meta && typeof meta === 'object' ? meta.metadata : undefined
  let headerSuffix: React.ReactNode = null
  if (isMcp && item.server_label) {
    headerSuffix = <span className="font-mono text-xs text-warning/90"> — {item.server_label}/{item.tool}</span>
  } else if ((displayType === 'file_write' || displayType === 'diff') && metaInner && typeof metaInner.file_path === 'string' && metaInner.file_path) {
    headerSuffix = <span className="font-mono text-xs text-warning/90"> — {metaInner.file_path}</span>
  } else if (displayType === 'command' && metaInner && typeof metaInner.command === 'string' && metaInner.command) {
    const cmd = metaInner.command
    const truncated = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd
    headerSuffix = <span className="font-mono text-xs text-warning/90"> — {truncated}</span>
  }

  const canCollapse = !!richBody && typeof displayType === 'string' && COLLAPSIBLE_DISPLAY_TYPES.has(displayType)
  const showQueueBadge = typeof queueTotal === 'number' && queueTotal > 1

  return (
    <div className="relative min-w-0 max-w-full overflow-hidden rounded-md border border-warning bg-secondary p-3">
      {showQueueBadge ? (
        <div className="absolute top-2 right-2 text-[10px] uppercase tracking-wide text-warning bg-warning/10 border border-warning/40 rounded px-1.5 py-0.5">
          {queuePosition} of {queueTotal} pending
        </div>
      ) : null}
      <div className="break-words pr-24 text-sm font-semibold text-warning">
        {isMcp ? 'Approve MCP call' : `Approve ${item.tool}`}
        {headerSuffix}
      </div>
      {summary ? <div className="mt-0.5 break-words text-xs text-muted-foreground">{summary}</div> : null}
      <div className="mt-2">
        {richBody ? (
          <>
            <div className={`${expanded ? 'max-h-none' : 'max-h-[40vh]'} min-w-0 max-w-full overflow-auto`}>
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
        <button className="px-3 py-1.5 text-xs rounded-md border border-destructive text-destructive bg-transparent hover:bg-destructive/20" onClick={() => onDecision && onDecision(item.request_id, 'no', item.kind)}>Reject</button>
        {/* The MCP approval path has no ``always_approve`` flag —
            omniagents 0.16 intentionally omits it. Hide the button so
            we don't expose a no-op affordance. */}
        {!isMcp && (
          <button className="px-3 py-1.5 text-xs rounded-md border border-primary text-primary bg-transparent hover:bg-muted" onClick={() => onDecision && onDecision(item.request_id, 'always', item.kind)}>Always</button>
        )}
        <button className="px-3 py-1.5 text-xs rounded-md bg-primary hover:brightness-110 text-primary-foreground" onClick={() => onDecision && onDecision(item.request_id, 'yes', item.kind)}>{isMcp ? 'Approve' : 'Approve Once'}</button>
      </div>
    </div>
  )
}

function PlanCard({ item, onDecision }: { item: PlanItem; onDecision?: (approved: boolean) => void }) {
  return (
    <Plan defaultOpen>
      <PlanHeader>
        <div className="min-w-0 max-w-full">
          <PlanTitle>{item.title}</PlanTitle>
          {item.description ? <PlanDescription>{item.description}</PlanDescription> : null}
        </div>
      </PlanHeader>
      <PlanContent>
        <ol className="space-y-2 list-none">
          {item.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircleIcon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="min-w-0 max-w-full overflow-hidden">
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
