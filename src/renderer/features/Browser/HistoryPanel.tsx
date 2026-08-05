/** Searchable browser history presented as a shadcn dialog and item list. */
import './HistoryPanel.css';

import { Globe, Search, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { fallbackTitle } from '@/lib/url';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserHistoryEntry, BrowserProfileId } from '@/shared/types';

function formatTime(timestamp: number): string {
  const difference = Date.now() - timestamp;
  if (difference < 60_000) {
    return 'just now';
  }
  if (difference < 3_600_000) {
    return `${Math.round(difference / 60_000)}m ago`;
  }
  if (difference < 86_400_000) {
    return `${Math.round(difference / 3_600_000)}h ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export const HistoryPanel = memo(
  ({
    profileId,
    onOpen,
    onClose,
  }: {
    profileId?: BrowserProfileId;
    onOpen: (url: string) => void;
    onClose: () => void;
  }) => {
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState<BrowserHistoryEntry[]>([]);
    const sequenceRef = useRef(0);

    const refresh = useCallback(
      async (nextQuery: string) => {
        const sequence = ++sequenceRef.current;
        const result = await browserApi.listHistory({
          query: nextQuery,
          limit: 200,
          ...(profileId ? { profileId } : {}),
        });
        if (sequence === sequenceRef.current) {
          setEntries(result);
        }
      },
      [profileId]
    );

    useEffect(() => {
      void refresh('');
    }, [refresh]);

    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const nextQuery = event.target.value;
        setQuery(nextQuery);
        void refresh(nextQuery);
      },
      [refresh]
    );

    const handleClear = useCallback(async () => {
      await browserApi.clearHistory(profileId ? { profileId } : undefined);
      await refresh(query);
    }, [profileId, query, refresh]);

    const handleOpen = useCallback(
      (url: string) => {
        onOpen(url);
        onClose();
      },
      [onClose, onOpen]
    );

    return (
      <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="omni-browser-history-dialog flex max-w-160 flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="px-4 py-3 text-left">
            <DialogTitle>History</DialogTitle>
            <DialogDescription>Search pages visited in this browser profile.</DialogDescription>
          </DialogHeader>
          <div className="border-b p-3">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={handleChange}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && entries[0]) {
                    event.preventDefault();
                    handleOpen(entries[0].url);
                  }
                }}
                placeholder="Search history"
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
            </InputGroup>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {entries.length === 0 ? (
              <Empty className="border-0 py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Globe />
                  </EmptyMedia>
                  <EmptyTitle>{query ? 'No matches' : 'No history yet'}</EmptyTitle>
                  <EmptyDescription>
                    {query ? 'Try a different search.' : 'Pages you visit will appear here.'}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="p-1">
                {entries.map((entry) => (
                  <Item
                    key={entry.id}
                    asChild
                    size="sm"
                    className="w-full cursor-pointer flex-nowrap text-left hover:bg-accent/50"
                  >
                    <button type="button" onClick={() => handleOpen(entry.url)}>
                      <ItemMedia>
                        <Globe />
                      </ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle className="max-w-full truncate">{entry.title ?? fallbackTitle(entry.url)}</ItemTitle>
                        <ItemDescription className="truncate text-left">{entry.url}</ItemDescription>
                      </ItemContent>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(entry.visitedAt)}</span>
                    </button>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </ScrollArea>
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>{entries.length} entries</span>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleClear}>
              <Trash2 />
              Clear history
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

HistoryPanel.displayName = 'HistoryPanel';
