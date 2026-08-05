/**
 * Console tab — displays messages captured from the webview's
 * `onConsoleMessage` callback. BrowserView buffers entries and passes them in.
 */
import { Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import type { ConsoleMessage } from '@/renderer/common/Webview';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';

type Entry = ConsoleMessage & { timestamp: number };
type LevelFilter = 'all' | 'log' | 'warn' | 'error';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d
    .getSeconds()
    .toString()
    .padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0').slice(0, 2)}`;
}

export const ConsoleTab = memo(({ entries, onClear }: { entries: Entry[]; onClear: () => void }) => {
  const [level, setLevel] = useState<LevelFilter>('all');
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries — standard devtools behavior.
  useEffect(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }
    // Only auto-scroll if the user is already near the bottom.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const filtered = level === 'all' ? entries : entries.filter((e) => e.level === level);

  const counts = {
    all: entries.length,
    log: entries.filter((e) => e.level === 'log').length,
    warn: entries.filter((e) => e.level === 'warn').length,
    error: entries.filter((e) => e.level === 'error').length,
  };

  const LEVELS: { id: LevelFilter; label: string }[] = [
    { id: 'all', label: `All (${counts.all})` },
    { id: 'log', label: `Log (${counts.log})` },
    { id: 'warn', label: `Warn (${counts.warn})` },
    { id: 'error', label: `Error (${counts.error})` },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1 h-7 pl-4 pr-4 border-b border-border bg-card text-xs">
        <ToggleGroup
          type="single"
          value={level}
          onValueChange={(value) => value && setLevel(value as LevelFilter)}
          size="sm"
          className="gap-0.5"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem key={l.id} value={l.id} className="h-5.5 px-2 text-xs">
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="icon-xs" onClick={onClear} aria-label="Clear console">
          <Trash2 />
        </Button>
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1 font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground font-inherit">Nothing logged yet.</div>
        ) : (
          filtered.map((e, i) => (
            <div
              key={i}
              className={cn(
                'px-3 py-0.5 border-b border-muted flex items-start gap-2 whitespace-pre-wrap break-words',
                e.level === 'warn' && 'bg-warning/10 text-warning',
                e.level === 'error' && 'bg-destructive/10 text-destructive',
                e.level !== 'warn' && e.level !== 'error' && 'text-foreground'
              )}
            >
              <span className="w-14 flex-none text-muted-foreground text-xs">{formatTime(e.timestamp)}</span>
              <span className="w-10 flex-none text-xs uppercase">{e.level}</span>
              <span>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
});
ConsoleTab.displayName = 'ConsoleTab';
