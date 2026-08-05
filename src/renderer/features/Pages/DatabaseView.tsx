import { memo, useCallback, useMemo, useState } from 'react';

import { Empty, EmptyDescription, EmptyHeader } from '@/renderer/ds/ui/empty';
import { Input } from '@/renderer/ds/ui/input';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import type { Page, PageId } from '@/shared/types';

export type DatabaseViewMode = 'table' | 'list';

export type DatabaseViewProps = {
  pages: Page[];
  mode?: DatabaseViewMode;
  onOpen?: (id: PageId) => void;
  onCreate?: (input: { title: string }) => Promise<unknown> | unknown;
  createPlaceholder?: string;
  emptyState?: string;
};

export const DatabaseView = memo(
  ({ pages, onOpen, onCreate, createPlaceholder = 'New page…', emptyState = 'No pages yet.' }: DatabaseViewProps) => {
    const [draft, setDraft] = useState('');

    const sorted = useMemo(() => [...pages].sort((a, b) => b.updatedAt - a.updatedAt), [pages]);

    const submit = useCallback(async () => {
      const title = draft.trim();
      if (!title || !onCreate) {
        return;
      }
      await onCreate({ title });
      setDraft('');
    }, [draft, onCreate]);

    return (
      <div className="flex flex-col w-full h-full">
        {sorted.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyDescription>{emptyState}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {sorted.map((page) => (
              <Item
                key={page.id}
                asChild
                size="sm"
                className="w-full cursor-pointer rounded-none border-b hover:bg-accent"
              >
                <button type="button" onClick={() => onOpen?.(page.id)}>
                  <ItemMedia>{page.icon ?? '📄'}</ItemMedia>
                  <ItemContent>
                    <ItemTitle className="truncate">{page.title || 'Untitled'}</ItemTitle>
                  </ItemContent>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(page.updatedAt)}</span>
                </button>
              </Item>
            ))}
          </ItemGroup>
        )}
        {onCreate && (
          <div className="flex items-center gap-2 pl-5 pr-4 pt-2.5 pb-2.5 border-t border-border">
            <span className="shrink-0 text-base w-5 text-center">＋</span>
            <Input
              className="h-8 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                } else if (e.key === 'Escape') {
                  setDraft('');
                }
              }}
              placeholder={createPlaceholder}
            />
          </div>
        )}
      </div>
    );
  }
);
DatabaseView.displayName = 'DatabaseView';

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return 'just now';
  }
  if (delta < hour) {
    return `${Math.floor(delta / minute)}m`;
  }
  if (delta < day) {
    return `${Math.floor(delta / hour)}h`;
  }
  return `${Math.floor(delta / day)}d`;
}
