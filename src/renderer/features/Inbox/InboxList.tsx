import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiCaretRightBold, PiPlusBold, PiTrashFill } from 'react-icons/pi';

import { Badge, cn, FAB, IconButton } from '@/renderer/ds';
import { daysRemaining } from '@/lib/inbox-expiry';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, InboxItemId, InboxItemStatus } from '@/shared/types';

import { $inboxItems, $iceboxItems, inboxApi, openQuickCapture } from './state';

const STATUS_DOT: Record<InboxItemStatus, string> = {
  open: 'bg-blue-400',
  done: 'bg-green-400',
  deferred: 'bg-fg-muted/50',
  iceboxed: 'bg-fg-muted/30',
};

const STATUS_LABELS: Record<InboxItemStatus, string> = {
  open: 'Open',
  done: 'Done',
  deferred: 'Deferred',
  iceboxed: 'Iceboxed',
};

type InboxFilter = 'all' | 'open' | 'done';

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
];

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const InboxCard = memo(
  ({
    item,
    isSelected,
    isFocused,
    onSelect,
    onDelete,
  }: {
    item: InboxItem;
    isSelected: boolean;
    isFocused: boolean;
    onSelect: (id: InboxItemId) => void;
    onDelete: (id: InboxItemId) => void;
  }) => {
    const store = useStore(persistedStoreApi.$atom);
    const ref = useRef<HTMLButtonElement>(null);
    const project = useMemo(
      () => (item.projectId ? store.projects.find((p) => p.id === item.projectId) : null),
      [item.projectId, store.projects]
    );

    useEffect(() => {
      if (isFocused && ref.current) {
        ref.current.scrollIntoView({ block: 'nearest' });
      }
    }, [isFocused]);

    const handleClick = useCallback(() => onSelect(item.id), [item.id, onSelect]);
    const handleDelete = useCallback(() => {
      onDelete(item.id);
    }, [item.id, onDelete]);

    return (
      <button
        ref={ref}
        onClick={handleClick}
        className={cn(
          'group flex items-center gap-3 w-full px-4 py-3.5 text-left transition-colors cursor-pointer rounded-xl',
          isSelected ? 'bg-accent-600/10' : isFocused ? 'bg-white/5' : 'hover:bg-white/5'
        )}
      >
        {/* Leading status dot */}
        <span className={cn('size-2.5 rounded-full shrink-0', STATUS_DOT[item.status])} title={STATUS_LABELS[item.status]} />

        {/* Content */}
        <div className="flex flex-col flex-1 min-w-0 gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm text-fg truncate">{item.title}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            <span>{timeAgo(item.createdAt)}</span>
            {item.status === 'open' && (() => {
              const days = daysRemaining(item, Date.now());
              return (
                <>
                  <span className="text-fg-muted/30">&middot;</span>
                  <span className={cn(days <= 1 ? 'text-amber-400' : 'text-fg-subtle')}>
                    {days <= 0 ? 'expiring' : `${days}d left`}
                  </span>
                </>
              );
            })()}
            {item.status === 'open' && (
              <>
                <span className="text-fg-muted/30">&middot;</span>
                {item.shaping ? (
                  <span className="text-green-400">Shaped</span>
                ) : (
                  <span className="text-fg-muted">Needs shaping</span>
                )}
              </>
            )}
            {project && (
              <>
                <span className="text-fg-muted/30">&middot;</span>
                <span className="text-purple-400 truncate">{project.label}</span>
              </>
            )}
          </div>
        </div>

        {/* Trailing actions */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <IconButton
            aria-label="Delete"
            icon={<PiTrashFill size={12} />}
            size="sm"
            onClick={handleDelete}
            className="opacity-70 sm:opacity-0 sm:group-hover:opacity-70 hover:!opacity-100 transition-opacity"
          />
          <PiCaretRightBold size={12} className="text-fg-muted/40 hidden sm:block" />
        </div>
      </button>
    );
  }
);
InboxCard.displayName = 'InboxCard';

export const InboxList = memo(
  ({
    selectedId,
    onSelect,
    onShowIcebox,
  }: {
    selectedId: InboxItemId | null;
    onSelect: (id: InboxItemId | null) => void;
    onShowIcebox?: () => void;
  }) => {
    const itemsMap = useStore($inboxItems);
    const iceboxMap = useStore($iceboxItems);
    const [filter, setFilter] = useState<InboxFilter>('all');
    const [focusIndex, setFocusIndex] = useState(-1);
    const listRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => {
      let list = Object.values(itemsMap).filter((i) => i.status !== 'iceboxed');
      if (filter !== 'all') {
        list = list.filter((i) => i.status === filter);
      }
      return list.sort((a, b) => a.createdAt - b.createdAt);
    }, [itemsMap, filter]);

    const openCount = useMemo(() => Object.values(itemsMap).filter((i) => i.status === 'open').length, [itemsMap]);

    useEffect(() => {
      setFocusIndex((prev) => Math.min(prev, items.length - 1));
    }, [items.length]);

    const handleSelect = useCallback(
      (id: InboxItemId) => {
        onSelect(selectedId === id ? null : id);
      },
      [selectedId, onSelect]
    );

    const handleDelete = useCallback(async (id: InboxItemId) => {
      await inboxApi.removeItem(id);
    }, []);

    // Keyboard navigation on the list
    const handleListKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const focusedItem = focusIndex >= 0 && focusIndex < items.length ? items[focusIndex] : null;

        switch (e.key) {
          case 'j':
          case 'ArrowDown':
            e.preventDefault();
            setFocusIndex((prev) => Math.min(prev + 1, items.length - 1));
            break;
          case 'k':
          case 'ArrowUp':
            e.preventDefault();
            if (focusIndex <= 0) {
              setFocusIndex(-1);
            } else {
              setFocusIndex((prev) => prev - 1);
            }
            break;
          case 'Enter':
            e.preventDefault();
            if (focusedItem) onSelect(focusedItem.id);
            break;
          case 'x':
            e.preventDefault();
            if (focusedItem && focusedItem.status !== 'done') {
              void inboxApi.updateItem(focusedItem.id, { status: 'done' });
            }
            break;
          case 'Backspace':
          case 'Delete':
            e.preventDefault();
            if (focusedItem) {
              void inboxApi.removeItem(focusedItem.id);
              setFocusIndex((prev) => Math.min(prev, items.length - 2));
            }
            break;
          case 'Escape':
            e.preventDefault();
            setFocusIndex(-1);
            break;
        }
      },
      [focusIndex, items, onSelect]
    );

    return (
      <div className="relative flex flex-col w-full h-full">
        {/* Header — desktop: title + select, mobile: just filter chips */}
        <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-surface-border shrink-0">
          {/* Desktop title row */}
          <div className="hidden sm:flex items-center gap-2">
            <span className="text-sm font-semibold text-fg">Inbox</span>
            {openCount > 0 && (
              <Badge color="blue">{openCount}</Badge>
            )}
            <div className="flex-1" />
            <IconButton aria-label="New item" icon={<PiPlusBold />} size="sm" onClick={openQuickCapture} />
          </div>

          {/* Filter chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  filter === f.value
                    ? 'bg-accent-600/20 text-accent-400'
                    : 'bg-surface-overlay text-fg-muted hover:text-fg hover:bg-surface-overlay/80'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto focus:outline-none px-2 sm:px-3 py-2"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 h-full px-4">
              <p className="text-fg-muted text-sm">Inbox is empty</p>
              <p className="text-fg-subtle text-xs hidden sm:block">
                <kbd className="px-1 py-0.5 rounded border border-surface-border text-xs">Ctrl+I</kbd> to capture from anywhere
              </p>
              <p className="text-fg-subtle text-xs sm:hidden">Tap + to add an item</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                {items.map((item, index) => (
                  <InboxCard
                    key={item.id}
                    item={item}
                    isSelected={selectedId === item.id}
                    isFocused={focusIndex === index}
                    onSelect={handleSelect}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
              <div className="hidden sm:flex flex-wrap gap-x-3 gap-y-1 px-4 py-2 text-xs text-fg-subtle">
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">j</kbd>/<kbd className="px-1 py-0.5 rounded border border-surface-border">k</kbd> navigate</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">Enter</kbd> open</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">x</kbd> done</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">Del</kbd> remove</span>
              </div>
            </>
          )}
        </div>

        {/* Icebox link */}
        {onShowIcebox && (() => {
          const iceboxCount = Object.keys(iceboxMap).length;
          if (iceboxCount === 0) return null;
          return (
            <button
              onClick={onShowIcebox}
              className="shrink-0 px-4 py-2.5 border-t border-surface-border text-xs text-fg-subtle hover:text-fg transition-colors text-left"
            >
              View icebox ({iceboxCount} item{iceboxCount !== 1 ? 's' : ''})
            </button>
          );
        })()}

        <FAB icon={<PiPlusBold size={22} />} onClick={openQuickCapture} aria-label="New item" className="sm:hidden" />
      </div>
    );
  }
);
InboxList.displayName = 'InboxList';
