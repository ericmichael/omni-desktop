/**
 * Downloads tray — a toolbar button that opens a dropdown listing every
 * download the main-process `DownloadsManager` has tracked this session.
 *
 * Click a completed item to open it; the context menu exposes "show in
 * folder" and "remove from list". A small badge on the button surfaces the
 * count of active downloads so users notice progress even without opening
 * the tray.
 */

import { useStore } from '@nanostores/react';
import { CircleCheck, CircleX, Download, FolderOpen, Trash2 } from 'lucide-react';
import { atom } from 'nanostores';
import { memo, useCallback, useState } from 'react';

import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/renderer/ds/ui/context-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ItemContent, ItemGroup, ItemMedia } from '@/renderer/ds/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/ds/ui/popover';
import { Progress } from '@/renderer/ds/ui/progress';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { BrowserDownloadEntry } from '@/shared/types';

export const $downloads = atom<BrowserDownloadEntry[]>([]);

ipc.on('browser:downloads-changed', (list) => {
  $downloads.set(list ?? []);
});

void emitter
  .invoke('browser:downloads-list')
  .then((list) => $downloads.set(list ?? []))
  .catch(() => {
    /* server mode / race — atom already has [] */
  });

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DownloadRow = memo(({ entry }: { entry: BrowserDownloadEntry }) => {
  const pct = entry.totalBytes > 0 ? Math.min(100, Math.round((entry.receivedBytes / entry.totalBytes) * 100)) : 0;

  const handleOpen = useCallback(() => {
    if (entry.state !== 'completed') {
      return;
    }
    void emitter.invoke('browser:downloads-open-file', entry.id).catch(() => {});
  }, [entry.id, entry.state]);

  const handleShowFolder = useCallback(() => {
    void emitter.invoke('browser:downloads-show-in-folder', entry.id).catch(() => {});
  }, [entry.id]);

  const handleRemove = useCallback(() => {
    void emitter.invoke('browser:downloads-remove', entry.id).catch(() => {});
  }, [entry.id]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-2.5 px-4 py-3 font-normal"
          onClick={handleOpen}
        >
          {entry.state === 'completed' ? (
            <ItemMedia>
              <CircleCheck className="size-4 text-success" />
            </ItemMedia>
          ) : entry.state === 'interrupted' || entry.state === 'cancelled' ? (
            <ItemMedia>
              <CircleX className="size-4 text-destructive" />
            </ItemMedia>
          ) : (
            <ItemMedia>
              <Download className="size-4" />
            </ItemMedia>
          )}
          <ItemContent className="min-w-0 gap-1 text-left">
            <div className="truncate text-xs text-foreground">{entry.filename}</div>
            <div className="truncate text-xs text-muted-foreground">
              {entry.state === 'completed'
                ? formatBytes(entry.receivedBytes)
                : entry.state === 'cancelled'
                  ? 'Cancelled'
                  : entry.state === 'interrupted'
                    ? 'Failed'
                    : `${formatBytes(entry.receivedBytes)} / ${formatBytes(entry.totalBytes)}`}
            </div>
            {(entry.state === 'progressing' || entry.state === 'paused') && <Progress value={pct} className="h-0.5" />}
          </ItemContent>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {entry.state === 'completed' && <ContextMenuItem onSelect={handleOpen}>Open</ContextMenuItem>}
        {entry.savePath && (
          <ContextMenuItem onSelect={handleShowFolder}>
            <FolderOpen />
            Show in folder
          </ContextMenuItem>
        )}
        <ContextMenuItem variant="destructive" onSelect={handleRemove}>
          <Trash2 />
          Remove from list
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
DownloadRow.displayName = 'DownloadRow';

export const DownloadsTray = memo(() => {
  const items = useStore($downloads);
  const [open, setOpen] = useState(false);

  const activeCount = items.filter((e) => e.state === 'progressing' || e.state === 'paused').length;

  const handleClear = useCallback(() => {
    void emitter.invoke('browser:downloads-clear').catch(() => {});
  }, []);

  if (items.length === 0 && !open) {
    // Hide the button entirely when nothing has downloaded yet — less chrome
    // for the common case. Menu re-appears the moment a download starts.
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="relative"
          aria-label={`Downloads (${items.length})`}
        >
          <Download className="size-4" />
          {activeCount > 0 && (
            <Badge className="pointer-events-none absolute -top-1 -right-1 h-3.5 min-w-3.5 px-1 text-xs">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col p-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Downloads</span>
          {items.length > 0 && (
            <Button type="button" variant="ghost" size="xs" onClick={handleClear}>
              Clear completed
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-96">
          {items.length === 0 ? (
            <Empty className="min-h-40 border-0 p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Download />
                </EmptyMedia>
                <EmptyTitle>No downloads</EmptyTitle>
                <EmptyDescription>Downloads from this session will appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="p-1">
              {items.map((e) => (
                <DownloadRow key={e.id} entry={e} />
              ))}
            </ItemGroup>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
});
DownloadsTray.displayName = 'DownloadsTray';
