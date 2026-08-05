import { CheckIcon, CopyIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import {
  createContext,
  forwardRef,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/renderer/ds/ui/tooltip';

export interface WebPreviewContextValue {
  url: string;
  setUrl: (url: string) => void;
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const useWebPreview = () => {
  const context = useContext(WebPreviewContext);
  if (!context) {
    throw new Error('WebPreview components must be used within a WebPreview');
  }
  return context;
};

/** Public alias for consuming the context outside of ai-elements components. */
export { useWebPreview as useWebPreviewContext };

export type WebPreviewProps = ComponentProps<'div'> & {
  defaultUrl?: string;
  onUrlChange?: (url: string) => void;
};

export const WebPreview = ({ className, children, defaultUrl = '', onUrlChange, ...props }: WebPreviewProps) => {
  const [url, setUrl] = useState(defaultUrl);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const handleUrlChange = useCallback(
    (newUrl: string) => {
      setUrl(newUrl);
      onUrlChange?.(newUrl);
    },
    [onUrlChange]
  );

  const contextValue = useMemo<WebPreviewContextValue>(
    () => ({
      consoleOpen,
      setConsoleOpen,
      setUrl: handleUrlChange,
      url,
    }),
    [consoleOpen, handleUrlChange, url]
  );

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div className={cn('flex size-full flex-col rounded-lg border bg-card', className)} {...props}>
        <ResizablePanelGroup orientation="vertical">{children}</ResizablePanelGroup>
      </div>
    </WebPreviewContext.Provider>
  );
};

export type WebPreviewNavigationProps = ComponentProps<'div'>;

export const WebPreviewNavigation = ({ className, children, ...props }: WebPreviewNavigationProps) => (
  <ResizablePanel
    id="navigation"
    defaultSize={49}
    minSize={49}
    maxSize={49}
    disabled
    groupResizeBehavior="preserve-pixel-size"
  >
    <div className={cn('flex h-full items-center gap-1 border-b p-2', className)} {...props}>
      {children}
    </div>
  </ResizablePanel>
);

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

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
);

export type WebPreviewUrlProps = ComponentProps<typeof Input>;

export const WebPreviewUrl = forwardRef<HTMLInputElement, WebPreviewUrlProps>(
  ({ value, onChange, onKeyDown, ...props }, ref) => {
    const { url, setUrl } = useWebPreview();
    const [prevUrl, setPrevUrl] = useState(url);
    const [inputValue, setInputValue] = useState(url);

    // Sync input value with context URL when it changes externally (derived state pattern)
    if (url !== prevUrl) {
      setPrevUrl(url);
      setInputValue(url);
    }

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(event.target.value);
      onChange?.(event);
    };

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          const target = event.target as HTMLInputElement;
          setUrl(target.value);
        }
        onKeyDown?.(event);
      },
      [setUrl, onKeyDown]
    );

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
    );
  }
);
WebPreviewUrl.displayName = 'WebPreviewUrl';

export type WebPreviewBodyProps = ComponentProps<'iframe'> & {
  loading?: ReactNode;
};

export const WebPreviewBody = ({ className, loading, src, ...props }: WebPreviewBodyProps) => {
  const { url } = useWebPreview();

  return (
    <ResizablePanel id="preview" minSize={80}>
      <div className="relative size-full">
        <iframe
          className={cn('size-full', className)}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
          src={(src ?? url) || undefined}
          title="Preview"
          {...props}
        />
        {loading}
      </div>
    </ResizablePanel>
  );
};

export type ConsoleLogEntry = {
  level: 'log' | 'warn' | 'error' | 'result';
  message: string;
  timestamp: Date;
};

export type WebPreviewConsoleProps = ComponentProps<'div'> & {
  logs?: ConsoleLogEntry[];
  onClear?: () => void;
  onExecute?: (code: string) => void;
};

const LEVEL_LABELS = ['all', 'error', 'warn', 'log'] as const;
type LevelFilter = (typeof LEVEL_LABELS)[number];

const CopyButton = ({ text, className }: { text: string; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      className={cn(
        'shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/log:opacity-100',
        className
      )}
      aria-label="Copy"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </Button>
  );
};

const MIN_CONSOLE_HEIGHT = 80;
const DEFAULT_CONSOLE_HEIGHT = 200;
const MAX_CONSOLE_HEIGHT = 600;

export const WebPreviewConsole = ({
  className,
  logs = [],
  onClear,
  onExecute,
  children,
  ...props
}: WebPreviewConsoleProps) => {
  const { consoleOpen, setConsoleOpen } = useWebPreview();
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [scriptInput, setScriptInput] = useState('');
  const [copyAllDone, setCopyAllDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs]);
  const warnCount = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs]);

  const filtered = useMemo(() => (filter === 'all' ? logs : logs.filter((l) => l.level === filter)), [logs, filter]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el && consoleOpen) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length, consoleOpen]);

  const handleCopyAll = useCallback(() => {
    const text = filtered
      .map((l) => `[${l.timestamp.toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopyAllDone(true);
      setTimeout(() => setCopyAllDone(false), 1500);
    });
  }, [filtered]);

  const handleExec = useCallback(() => {
    const code = scriptInput.trim();
    if (!code) {
      return;
    }
    onExecute?.(code);
    setScriptInput('');
  }, [scriptInput, onExecute]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleExec();
      }
    },
    [handleExec]
  );

  if (!consoleOpen) {
    return null;
  }

  return (
    <Fragment>
      <ResizableHandle />
      <ResizablePanel
        id="console"
        defaultSize={DEFAULT_CONSOLE_HEIGHT}
        minSize={MIN_CONSOLE_HEIGHT}
        maxSize={MAX_CONSOLE_HEIGHT}
        groupResizeBehavior="preserve-pixel-size"
      >
        <div className={cn('flex size-full flex-col bg-muted font-mono text-sm', className)} {...props}>
          {/* Toolbar */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border/50 px-3 py-1">
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(value) => value && setFilter(value as LevelFilter)}
              size="sm"
              className="gap-0.5"
            >
              {LEVEL_LABELS.map((level) => (
                <ToggleGroupItem key={level} value={level} className="h-6 px-1.5 text-xs">
                  {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
                  {level === 'error' && errorCount > 0 && <span className="ml-1 text-destructive">{errorCount}</span>}
                  {level === 'warn' && warnCount > 0 && <span className="ml-1 text-warning">{warnCount}</span>}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex-1" />
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleCopyAll}
                    disabled={filtered.length === 0}
                    className="text-muted-foreground"
                    aria-label="Copy all"
                  >
                    {copyAllDone ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Copy all logs</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={onClear}
                    disabled={logs.length === 0}
                    className="text-muted-foreground"
                    aria-label="Clear console"
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Clear console</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setConsoleOpen(false)}
                    className="text-muted-foreground"
                    aria-label="Close console"
                  >
                    <XIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Close console</p>
                </TooltipContent>
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
                    'group/log flex items-start gap-2 border-b border-border/30 px-3 py-1 text-xs leading-relaxed last:border-b-0',
                    log.level === 'error' && 'bg-destructive/5 text-destructive',
                    log.level === 'warn' && 'bg-warning/5 text-warning',
                    log.level === 'log' && 'text-foreground',
                    log.level === 'result' && 'text-muted-foreground italic'
                  )}
                  key={`${i}-${log.timestamp.getTime()}-${log.level}`}
                >
                  <span className="shrink-0 select-none text-muted-foreground/60">
                    {log.timestamp.toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{log.message}</span>
                  <CopyButton text={log.message} />
                </div>
              ))
            )}
            {children}
          </div>

          {/* Script input */}
          {onExecute && (
            <div className="shrink-0 border-t border-border/50 px-3 py-1.5">
              <InputGroup className="h-7 border-0 shadow-none">
                <InputGroupAddon className="pl-0 text-xs text-muted-foreground/60">&gt;</InputGroupAddon>
                <InputGroupInput
                  type="text"
                  value={scriptInput}
                  onChange={(e) => setScriptInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Evaluate JavaScript..."
                  className="min-w-0 px-1 font-mono text-xs"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <InputGroupAddon align="inline-end" className="pr-0">
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InputGroupButton
                          size="icon-xs"
                          onClick={handleExec}
                          disabled={!scriptInput.trim()}
                          aria-label="Execute"
                        >
                          <PlayIcon className="size-3" />
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p>Run (Enter)</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </InputGroupAddon>
              </InputGroup>
            </div>
          )}
        </div>
      </ResizablePanel>
    </Fragment>
  );
};
