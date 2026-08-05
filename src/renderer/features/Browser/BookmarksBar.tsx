import { Star, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';

import { fallbackTitle } from '@/lib/url';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserBookmark } from '@/shared/types';

export const BookmarksBar = memo(
  ({ bookmarks, onOpen }: { bookmarks: BrowserBookmark[]; onOpen: (url: string) => void }) => {
    const handleRemove = useCallback((id: string) => {
      void browserApi.removeBookmark(id);
    }, []);

    // Hide the bar entirely when empty — don't clutter the chrome with a
    // "how to bookmark" hint. The bar reappears the moment a bookmark is
    // saved (Cmd+D / star button in the toolbar).
    if (bookmarks.length === 0) {
      return null;
    }

    return (
      <div className="flex items-center gap-1 h-7 pl-4 pr-4 border-b border-border bg-card overflow-x-auto overflow-y-hidden scrollbar-thin">
        {bookmarks.map((b) => {
          const label = b.title || fallbackTitle(b.url);
          return (
            <DropdownMenu key={b.id}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="inline-flex items-center gap-1 h-5.5 pl-2 pr-2 rounded-md border-0 bg-transparent text-muted-foreground text-xs cursor-pointer shrink-0 max-w-40 overflow-hidden text-ellipsis whitespace-nowrap hover:bg-accent hover:text-foreground"
                  title={`${b.title}\n${b.url}`}
                  onClick={() => onOpen(b.url)}
                >
                  <Star className="size-3 shrink-0" />
                  <span>{label}</span>
                </Button>
              </DropdownMenuTrigger>
              <>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => onOpen(b.url)}>Open</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleRemove(b.id)} className="text-destructive">
                    <Trash2 className="text-destructive" />
                    Remove bookmark
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </>
            </DropdownMenu>
          );
        })}
      </div>
    );
  }
);
BookmarksBar.displayName = 'BookmarksBar';
