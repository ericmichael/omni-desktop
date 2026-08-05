/**
 * Network tab — polls `app:network-log` while mounted and renders a live
 * table of requests. Click a row to inspect request/response detail.
 */
import { Search, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { NetworkLogEntry } from '@/main/app-control-cdp';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/ds/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId } from '@/shared/app-control-types';

type Filter = 'all' | 'xhr' | 'doc' | 'css' | 'js' | 'img' | 'err';

function matchesFilter(e: NetworkLogEntry, filter: Filter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'err') {
    return (e.status ?? 0) >= 400 || !!e.errorText;
  }
  const rt = (e.resourceType ?? '').toLowerCase();
  if (filter === 'xhr') {
    return rt === 'xhr' || rt === 'fetch';
  }
  if (filter === 'doc') {
    return rt === 'document';
  }
  if (filter === 'css') {
    return rt === 'stylesheet';
  }
  if (filter === 'js') {
    return rt === 'script';
  }
  if (filter === 'img') {
    return rt === 'image' || rt === 'media' || rt === 'font';
  }
  return true;
}

function formatDuration(e: NetworkLogEntry): string {
  if (e.endedAt === undefined) {
    return '…';
  }
  const ms = Math.max(0, (e.endedAt - e.startedAt) * 1000);
  if (ms < 10) {
    return `${ms.toFixed(1)} ms`;
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const NetworkTab = memo(({ handleId }: { handleId: AppHandleId }) => {
  const [entries, setEntries] = useState<NetworkLogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await emitter.invoke('app:network-log', handleId, { limit: 300 });
      setEntries(list ?? []);
    } catch {
      // webview not ready yet — retry on next tick
    }
  }, [handleId]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [refresh]);

  const handleClear = useCallback(async () => {
    try {
      await emitter.invoke('app:network-log', handleId, { clear: true, limit: 0 });
      setEntries([]);
      setSelectedId(null);
    } catch {
      // ignore
    }
  }, [handleId]);

  const filtered = entries.filter((e) => {
    if (!matchesFilter(e, filter)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const q = query.toLowerCase();
    return e.url.toLowerCase().includes(q) || e.method.toLowerCase().includes(q);
  });

  const selected = selectedId ? (entries.find((e) => e.requestId === selectedId) ?? null) : null;

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'xhr', label: 'XHR/Fetch' },
    { id: 'doc', label: 'Doc' },
    { id: 'js', label: 'JS' },
    { id: 'css', label: 'CSS' },
    { id: 'img', label: 'Img' },
    { id: 'err', label: 'Err' },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 h-7 pl-4 pr-4 border-b border-border bg-card text-xs">
        <InputGroup className="h-6 w-60 shrink-0">
          <InputGroupAddon className="pl-2">
            <Search className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            className="h-6 text-xs"
            placeholder="Filter URL or method"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </InputGroup>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => value && setFilter(value as Filter)}
          size="sm"
          className="h-6"
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} className="h-6 px-2 text-xs">
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">
          {filtered.length}/{entries.length}
        </span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6"
          onClick={() => void handleClear()}
          title="Clear"
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden text-xs font-mono">
          <Table className="table-fixed text-xs">
            <TableHeader className="sticky top-0 z-10 bg-card uppercase tracking-wide text-muted-foreground">
              <TableRow>
                <TableHead className="h-7 w-15 text-xs">Method</TableHead>
                <TableHead className="h-7 w-15 text-xs">Status</TableHead>
                <TableHead className="h-7 text-xs">URL</TableHead>
                <TableHead className="h-7 w-20 text-xs">Type</TableHead>
                <TableHead className="h-7 w-20 text-xs">Size</TableHead>
                <TableHead className="h-7 w-20 text-xs">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No requests yet.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((e) => {
                  const statusClass =
                    e.errorText || (e.status ?? 0) >= 500
                      ? 'text-destructive'
                      : (e.status ?? 0) >= 400
                        ? 'text-warning'
                        : undefined;
                  return (
                    <TableRow
                      key={e.requestId}
                      data-state={selectedId === e.requestId ? 'selected' : undefined}
                      className={cn('cursor-pointer', statusClass)}
                      onClick={() => setSelectedId(e.requestId)}
                    >
                      <TableCell className="truncate px-2 py-1">{e.method}</TableCell>
                      <TableCell className="truncate px-2 py-1">{e.errorText ? '—' : (e.status ?? '…')}</TableCell>
                      <TableCell className="truncate px-2 py-1 text-foreground" title={e.url}>
                        {e.url}
                      </TableCell>
                      <TableCell className="truncate px-2 py-1">{e.resourceType ?? ''}</TableCell>
                      <TableCell className="truncate px-2 py-1">{formatSize(e.encodedDataLength)}</TableCell>
                      <TableCell className="truncate px-2 py-1">{formatDuration(e)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {selected && (
          <div className="w-85 flex-none min-h-0 overflow-auto px-3 py-2.5 border-l border-border bg-card text-xs">
            <div className="text-xs uppercase text-muted-foreground mt-2.5">Method</div>
            <div className="break-all font-mono text-xs">{selected.method}</div>
            <div className="text-xs uppercase text-muted-foreground mt-2.5">URL</div>
            <div className="break-all font-mono text-xs">{selected.url}</div>
            <div className="text-xs uppercase text-muted-foreground mt-2.5">Status</div>
            <div className="break-all font-mono text-xs">
              {selected.status ?? '(pending)'} {selected.statusText ? `— ${selected.statusText}` : ''}
            </div>
            {selected.mimeType && (
              <>
                <div className="text-xs uppercase text-muted-foreground mt-2.5">MIME</div>
                <div className="break-all font-mono text-xs">{selected.mimeType}</div>
              </>
            )}
            {selected.resourceType && (
              <>
                <div className="text-xs uppercase text-muted-foreground mt-2.5">Type</div>
                <div className="break-all font-mono text-xs">{selected.resourceType}</div>
              </>
            )}
            {selected.encodedDataLength !== undefined && (
              <>
                <div className="text-xs uppercase text-muted-foreground mt-2.5">Size</div>
                <div className="break-all font-mono text-xs">{formatSize(selected.encodedDataLength)}</div>
              </>
            )}
            <div className="text-xs uppercase text-muted-foreground mt-2.5">Timing</div>
            <div className="break-all font-mono text-xs">{formatDuration(selected)}</div>
            {selected.errorText && (
              <>
                <div className="text-xs uppercase text-muted-foreground mt-2.5">Error</div>
                <div className="break-all font-mono text-xs">{selected.errorText}</div>
              </>
            )}
            {selected.fromCache && (
              <>
                <div className="text-xs uppercase text-muted-foreground mt-2.5">Cache</div>
                <div className="break-all font-mono text-xs">from disk cache</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
NetworkTab.displayName = 'NetworkTab';
