import { useStore } from '@nanostores/react';
import { Ellipsis, Plus, RotateCcw, Timer, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import type { InboxItem, InboxItemId } from '@/shared/types';

import { InboxItemDetail } from './InboxItemDetail';
import { $activeInbox, $inboxItems, $inboxView, $laterInbox, $promotedInbox, inboxApi } from './state';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type InboxTab = 'active' | 'later' | 'archive';

const EMPTY_COPY: Record<InboxTab, { title: string; description?: string }> = {
  active: { title: 'Inbox is empty', description: 'Capture anything and triage it here.' },
  later: { title: 'Nothing parked for later' },
  archive: { title: 'Nothing archived yet', description: 'Items promoted to tasks or projects are kept here.' },
};

/**
 * The Work tab's inbox view, following the tab's one-master grammar: the
 * list fills the content plane; opening an item replaces the plane with its
 * detail (back returns to the list) — the same shape as All work → task.
 * The open item lives in `$inboxView` (set here and by cross-tab jumps like
 * Home's inbox strip), so there is exactly one source of truth for "which
 * item is open". On mobile the host's TopAppBar titles the item and owns
 * back, so the detail's own back header renders on desktop only.
 */
export const InboxView = memo(() => {
  const isDesktop = useIsDesktop();
  const active = useStore($activeInbox);
  const later = useStore($laterInbox);
  const promoted = useStore($promotedInbox);
  const itemsById = useStore($inboxItems);
  const view = useStore($inboxView);

  const [tab, setTab] = useState<InboxTab>('active');

  // Resolve the selected item every render so edits made through IPC flow
  // back in via store:changed without having to reset local state.
  const selectedItem = useMemo(
    () => (view.selectedItemId ? (itemsById[view.selectedItemId] ?? null) : null),
    [view.selectedItemId, itemsById]
  );

  const visible = tab === 'active' ? active : tab === 'later' ? later : promoted;

  // Keep the tab in sync with wherever the selected item lives, so backing
  // out of a detail lands on the list that contains it.
  useEffect(() => {
    if (!selectedItem) {
      return;
    }
    if (selectedItem.promotedTo) {
      setTab('archive');
    } else if (selectedItem.status === 'later') {
      setTab('later');
    } else {
      setTab('active');
    }
  }, [selectedItem]);

  const handleBack = useCallback(() => {
    $inboxView.set({ selectedItemId: null });
  }, []);

  const handleAdd = useCallback(() => {
    $quickCaptureOpen.set(true);
  }, []);
  const handleTabSelect = useCallback((value: string) => {
    if (value === 'active' || value === 'later' || value === 'archive') {
      setTab(value);
    }
  }, []);
  const handleOpenItem = useCallback((id: InboxItemId) => $inboxView.set({ selectedItemId: id }), []);

  // The open item takes the whole plane (the Basecamp sub-page model).
  //
  // Keying on `selectedItem.id` forces a full remount when the user navigates
  // to a different item. Without the key, InboxItemDetail held per-item edit
  // buffers in component-local state tied to a prop, so switching items
  // either (a) silently dropped unsaved edits, or (b) wrote the previous
  // item's draft onto the newly-selected item via a stale `onBlur` closure.
  // Remount gives every item a fresh component lifecycle and makes the
  // buffers structurally incapable of crossing item boundaries.
  if (selectedItem) {
    return <InboxItemDetail key={selectedItem.id} item={selectedItem} onBack={handleBack} showBack={isDesktop} />;
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center pl-2 pr-2 border-b border-border shrink-0">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={tab}
          onValueChange={handleTabSelect}
          aria-label="Inbox view"
        >
          <ToggleGroupItem value="active">
            Inbox
            {active.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{active.length}</span>}
          </ToggleGroupItem>
          <ToggleGroupItem value="later">
            Later
            {later.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">{later.length}</span>}
          </ToggleGroupItem>
          <ToggleGroupItem value="archive">Archive</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex-1" />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Add item" onClick={handleAdd}>
          <Plus />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle className="text-base">{EMPTY_COPY[tab].title}</EmptyTitle>
              <EmptyDescription>{EMPTY_COPY[tab].description}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {tab === 'active' ? (
                <Button size="sm" onClick={handleAdd}>
                  <Plus />
                  Add item
                </Button>
              ) : undefined}
            </EmptyContent>
          </Empty>
        ) : (
          visible.map((item) => <InboxRow key={item.id} item={item} onOpen={handleOpenItem} />)
        )}
      </div>
    </div>
  );
});
InboxView.displayName = 'InboxView';

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type InboxRowProps = {
  item: InboxItem;
  onOpen: (id: InboxItemId) => void;
};

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

const InboxRow = memo(({ item, onOpen }: InboxRowProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const handleOpen = useCallback(() => onOpen(item.id), [item.id, onOpen]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onOpen(item.id);
      }
    },
    [item.id, onOpen]
  );
  const handleMenuOpenChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const handleDefer = useCallback(() => void inboxApi.defer(item.id), [item.id]);
  const handleReactivate = useCallback(() => void inboxApi.reactivate(item.id), [item.id]);
  const handleDrop = useCallback(() => void inboxApi.remove(item.id), [item.id]);

  return (
    // div+role rather than <button>: the row hosts the "…" menu button, and
    // nesting buttons inside a button is invalid markup.
    <div
      role="button"
      tabIndex={0}
      className="flex items-start gap-2 pl-5 pr-2 pt-2 pb-2 bg-transparent border-0 w-full text-left cursor-pointer hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2 [&:hover_.inbox-row-menu]:opacity-100 [&:focus-within_.inbox-row-menu]:opacity-100"
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-sm text-foreground overflow-hidden text-ellipsis whitespace-nowrap">{item.title}</span>
        {item.note && (
          <span className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {item.note}
          </span>
        )}
      </div>
      <span
        role="presentation"
        className={cn(
          'flex items-center shrink-0 opacity-0 transition-opacity duration-100',
          'inbox-row-menu',
          menuOpen && 'opacity-100'
        )}
        onClick={stopPropagation}
      >
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Item actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <>
            <DropdownMenuContent>
              {!item.promotedTo &&
                (item.status === 'later' ? (
                  <DropdownMenuItem onClick={handleReactivate}>
                    <RotateCcw />
                    Reactivate
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={handleDefer}>
                    <Timer />
                    Defer to later
                  </DropdownMenuItem>
                ))}
              <DropdownMenuItem onClick={handleDrop} className="text-destructive">
                <Trash2 />
                Drop
              </DropdownMenuItem>
            </DropdownMenuContent>
          </>
        </DropdownMenu>
      </span>
    </div>
  );
});
InboxRow.displayName = 'InboxRow';
