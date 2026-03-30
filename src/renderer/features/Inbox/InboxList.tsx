import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiPlusBold, PiTrashFill } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, InboxItemId, InboxItemStatus } from '@/shared/types';

import { $inboxItems, inboxApi, openQuickCapture } from './state';

const STATUS_COLORS: Record<InboxItemStatus, string> = {
  open: 'text-blue-400 bg-blue-400/10',
  done: 'text-green-400 bg-green-400/10',
  deferred: 'text-fg-muted bg-fg-muted/10',
};

const STATUS_LABELS: Record<InboxItemStatus, string> = {
  open: 'Open',
  done: 'Done',
  deferred: 'Deferred',
};

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
          'group flex flex-col gap-1.5 w-full px-4 py-3 text-left transition-colors border-b border-surface-border cursor-pointer',
          isSelected ? 'bg-accent-600/10' : isFocused ? 'bg-white/5' : 'hover:bg-white/5'
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-sm text-fg truncate">{item.title}</span>
            {item.description && (
              <span className="text-xs text-fg-muted truncate">{item.description}</span>
            )}
          </div>
          <span className="shrink-0 text-[10px] text-fg-subtle">{timeAgo(item.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', STATUS_COLORS[item.status])}>
            {STATUS_LABELS[item.status]}
          </span>
          {project && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-purple-400 bg-purple-400/10">
              {project.label}
            </span>
          )}
          {item.linkedTicketIds && item.linkedTicketIds.length > 0 && (
            <span className="text-[10px] text-fg-subtle">
              {item.linkedTicketIds.length} ticket{item.linkedTicketIds.length > 1 ? 's' : ''}
            </span>
          )}
          <div className="flex-1" />
          <IconButton
            aria-label="Delete"
            icon={<PiTrashFill size={12} />}
            size="sm"
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity"
          />
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
  }: {
    selectedId: InboxItemId | null;
    onSelect: (id: InboxItemId | null) => void;
  }) => {
    const itemsMap = useStore($inboxItems);
    const [filter, setFilter] = useState<InboxItemStatus | 'all'>('all');
    const [focusIndex, setFocusIndex] = useState(-1);
    const listRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => {
      let list = Object.values(itemsMap);
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
          case 'd':
            e.preventDefault();
            if (focusedItem && focusedItem.status === 'open') {
              void inboxApi.updateItem(focusedItem.id, { status: 'deferred' });
            }
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
      <div className="flex flex-col w-full h-full">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
          <span className="text-sm font-semibold text-fg">Inbox</span>
          {openCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-400/10 text-blue-400">
              {openCount}
            </span>
          )}
          <div className="flex-1" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as InboxItemStatus | 'all')}
            className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-fg focus:outline-none focus:border-accent-500"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="deferred">Deferred</option>
          </select>
          <IconButton aria-label="New item" icon={<PiPlusBold />} size="sm" onClick={openQuickCapture} />
        </div>

        {/* List */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto focus:outline-none"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 h-full">
              <p className="text-fg-muted text-sm">Inbox is empty</p>
              <p className="text-fg-subtle text-xs">
                <kbd className="px-1 py-0.5 rounded border border-surface-border text-[10px]">Ctrl+I</kbd> to capture from anywhere
              </p>
            </div>
          ) : (
            <>
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
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 py-2 text-[10px] text-fg-subtle">
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">j</kbd>/<kbd className="px-1 py-0.5 rounded border border-surface-border">k</kbd> navigate</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">Enter</kbd> open</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">x</kbd> done</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">d</kbd> defer</span>
                <span><kbd className="px-1 py-0.5 rounded border border-surface-border">Del</kbd> remove</span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
);
InboxList.displayName = 'InboxList';
