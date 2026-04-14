import { CheckIcon, CopyIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/omniagents-ui/components/ui/button'
import { Input } from '@/renderer/omniagents-ui/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/renderer/omniagents-ui/components/ui/tooltip'
import { cn } from '@/renderer/omniagents-ui/lib/utils'

export interface WebPreviewContextValue {
  url: string
  setUrl: (url: string) => void
  consoleOpen: boolean
  setConsoleOpen: (open: boolean) => void
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null)

const useWebPreview = () => {
  const context = useContext(WebPreviewContext)
  if (!context) {
    throw new Error('WebPreview components must be used within a WebPreview')
  }
  return context
}

/** Public alias for consuming the context outside of ai-elements components. */
export { useWebPreview as useWebPreviewContext }

export type WebPreviewProps = ComponentProps<'div'> & {
  defaultUrl?: string
  onUrlChange?: (url: string) => void
}

export const WebPreview = ({ className, children, defaultUrl = '', onUrlChange, ...props }: WebPreviewProps) => {
  const [url, setUrl] = useState(defaultUrl)
  const [consoleOpen, setConsoleOpen] = useState(false)

  const handleUrlChange = useCallback(
    (newUrl: string) => {
      setUrl(newUrl)
      onUrlChange?.(newUrl)
    },
    [onUrlChange]
  )

  const contextValue = useMemo<WebPreviewContextValue>(
    () => ({
      consoleOpen,
      setConsoleOpen,
      setUrl: handleUrlChange,
      url,
    }),
    [consoleOpen, handleUrlChange, url]
  )

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div className={cn('flex size-full flex-col rounded-lg border bg-card', className)} {...props}>
        {children}
      </div>
    </WebPreviewContext.Provider>
  )
}

export type WebPreviewNavigationProps = ComponentProps<'div'>

export const WebPreviewNavigation = ({ className, children, ...props }: WebPreviewNavigationProps) => (
  <div className={cn('flex items-center gap-1 border-b p-2', className)} {...props}>
    {children}
  </div>
)

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
  tooltip?: string
}

export const WebPreviewNavigationButton = ({
  onClick,
  disabled,
  tooltip,
  children,
  ...props
}: WebPreviewNavigationButtonProps) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className="h-8 w-8 p-0 hover:text-foreground"
          disabled={disabled}
          onClick={onClick}
          size="sm"
          variant="ghost"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

export type WebPreviewUrlProps = ComponentProps<typeof Input>

export const WebPreviewUrl = forwardRef<HTMLInputElement, WebPreviewUrlProps>(({ value, onChange, onKeyDown, ...props }, ref) => {
  const { url, setUrl } = useWebPreview()
  const [prevUrl, setPrevUrl] = useState(url)
  const [inputValue, setInputValue] = useState(url)

  // Sync input value with context URL when it changes externally (derived state pattern)
  if (url !== prevUrl) {
    setPrevUrl(url)
    setInputValue(url)
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value)
    onChange?.(event)
  }

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        const target = event.target as HTMLInputElement
        setUrl(target.value)
      }
      onKeyDown?.(event)
    },
    [setUrl, onKeyDown]
  )

  return (
    <Input
      ref={ref}
      className="h-8 flex-1 text-sm"
      onChange={onChange ?? handleChange}
      onKeyDown={handleKeyDown}
      placeholder="Enter URL..."
      value={value ?? inputValue}
      {...props}
    />
  )
})
WebPreviewUrl.displayName = 'WebPreviewUrl'

export type WebPreviewBodyProps = ComponentProps<'iframe'> & {
  loading?: ReactNode
}

export const WebPreviewBody = ({ className, loading, src, ...props }: WebPreviewBodyProps) => {
  const { url } = useWebPreview()

  return (
    <div className="flex-1">
      <iframe
        className={cn('size-full', className)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
        src={(src ?? url) || undefined}
        title="Preview"
        {...props}
      />
      {loading}
    </div>
  )
}

export type ConsoleLogEntry = {
  level: 'log' | 'warn' | 'error' | 'result'
  message: string
  timestamp: Date
}

export type WebPreviewConsoleProps = ComponentProps<'div'> & {
  logs?: ConsoleLogEntry[]
  onClear?: () => void
  onExecute?: (code: string) => void
}

const LEVEL_LABELS = ['all', 'error', 'warn', 'log'] as const
type LevelFilter = (typeof LEVEL_LABELS)[number]

const CopyButton = ({ text, className }: { text: string; className?: string }) => {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn('inline-flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/log:opacity-100', className)}
      aria-label="Copy"
    >
      {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
    </button>
  )
}

const MIN_CONSOLE_HEIGHT = 80
const DEFAULT_CONSOLE_HEIGHT = 200
const MAX_CONSOLE_HEIGHT = 600

export const WebPreviewConsole = ({ className, logs = [], onClear, onExecute, children, ...props }: WebPreviewConsoleProps) => {
  const { consoleOpen, setConsoleOpen } = useWebPreview()
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [scriptInput, setScriptInput] = useState('')
  const [copyAllDone, setCopyAllDone] = useState(false)
  const [height, setHeight] = useState(DEFAULT_CONSOLE_HEIGHT)
  const scrollRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)

  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs])
  const warnCount = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs])

  const filtered = useMemo(
    () => (filter === 'all' ? logs : logs.filter((l) => l.level === filter)),
    [logs, filter]
  )

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    const el = scrollRef.current
    if (el && consoleOpen) {
      el.scrollTop = el.scrollHeight
    }
  }, [filtered.length, consoleOpen])

  const handleCopyAll = useCallback(() => {
    const text = filtered
      .map((l) => `[${l.timestamp.toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopyAllDone(true)
      setTimeout(() => setCopyAllDone(false), 1500)
    })
  }, [filtered])

  const handleExec = useCallback(() => {
    const code = scriptInput.trim()
    if (!code) {
return
}
    onExecute?.(code)
    setScriptInput('')
  }, [scriptInput, onExecute])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleExec()
      }
    },
    [handleExec]
  )

  // Resize via drag
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    draggingRef.current = true
    startYRef.current = e.clientY
    startHeightRef.current = height
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [height])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) {
return
}
    const delta = startYRef.current - e.clientY
    setHeight(Math.min(MAX_CONSOLE_HEIGHT, Math.max(MIN_CONSOLE_HEIGHT, startHeightRef.current + delta)))
  }, [])

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false
  }, [])

  if (!consoleOpen) {
return null
}

  return (
    <div className={cn('flex flex-col border-t bg-muted/50 font-mono text-sm', className)} style={{ height }} {...props}>
      {/* Resize handle */}
      <div
        className="flex h-1.5 shrink-0 cursor-row-resize items-center justify-center hover:bg-accent/50 active:bg-accent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
      >
        <div className="h-0.5 w-8 rounded-full bg-border" />
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-3 py-1">
        <div className="flex items-center gap-0.5">
          {LEVEL_LABELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setFilter(level)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                filter === level
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
              {level === 'error' && errorCount > 0 && (
                <span className="ml-1 text-destructive">{errorCount}</span>
              )}
              {level === 'warn' && warnCount > 0 && (
                <span className="ml-1 text-yellow-600">{warnCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyAll}
                disabled={filtered.length === 0}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Copy all"
              >
                {copyAllDone ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Copy all logs</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClear}
                disabled={logs.length === 0}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Clear console"
              >
                <Trash2Icon className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Clear console</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setConsoleOpen(false)}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Close console"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Close console</p></TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {logs.length === 0 ? 'No console output' : 'No matching logs'}
          </p>
        ) : (
          filtered.map((log, i) => (
            <div
              className={cn(
                'group/log flex items-start gap-2 border-b border-border/30 px-3 py-1 text-[11px] leading-relaxed last:border-b-0',
                log.level === 'error' && 'bg-destructive/5 text-destructive',
                log.level === 'warn' && 'bg-yellow-500/5 text-yellow-600',
                log.level === 'log' && 'text-foreground',
                log.level === 'result' && 'text-blue-500 italic'
              )}
              key={`${i}-${log.timestamp.getTime()}-${log.level}`}
            >
              <span className="shrink-0 select-none text-muted-foreground/60">{log.timestamp.toLocaleTimeString()}</span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{log.message}</span>
              <CopyButton text={log.message} />
            </div>
          ))
        )}
        {children}
      </div>

      {/* Script input */}
      {onExecute && (
        <div className="flex shrink-0 items-center gap-1 border-t border-border/50 px-3 py-1.5">
          <span className="shrink-0 select-none text-[11px] text-muted-foreground/60">&gt;</span>
          <input
            type="text"
            value={scriptInput}
            onChange={(e) => setScriptInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Evaluate JavaScript..."
            className="flex-1 min-w-0 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/50"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleExec}
                  disabled={!scriptInput.trim()}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                  aria-label="Execute"
                >
                  <PlayIcon className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top"><p>Run (Enter)</p></TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  )
}
