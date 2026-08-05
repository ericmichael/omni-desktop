import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Globe, Pin, PinOff, Plus, X } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';

import { fallbackTitle } from '@/lib/url';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/renderer/ds/ui/context-menu';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserTab, BrowserTabId, BrowserTabset } from '@/shared/types';

type TabItemProps = {
  tab: BrowserTab;
  active: boolean;
  onSelect: (id: BrowserTabId) => void;
  onClose: (id: BrowserTabId) => void;
  onPinToggle: (id: BrowserTabId, pinned: boolean) => void;
  onDuplicate: (id: BrowserTabId) => void;
};

const TabItem = memo(({ tab, active, onSelect, onClose, onPinToggle, onDuplicate }: TabItemProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const title = tab.title ?? fallbackTitle(tab.url);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle-click closes — handled in mouseDown because the browser's
      // default middle-click (autoscroll) fires on mouseup.
      if (e.button === 1) {
        e.preventDefault();
        onClose(tab.id);
      }
    },
    [onClose, tab.id]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id]
  );

  // Stop pointer events from the close button (and other interactive
  // children) from reaching dnd-kit's sortable listeners on the parent
  // tab div. Without this, mouse jitter on click can activate the drag
  // sensor and swallow the synthetic click event.
  const stopPointer = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={cn(
            'flex items-center gap-1.5 pl-2.5 pr-1.5 mt-1 min-w-30 max-w-55 h-6.5 rounded-lg border-0 cursor-pointer select-none select-none text-muted-foreground bg-transparent transition-colors duration-100 hover:bg-accent hover:text-foreground',
            active && 'bg-background text-foreground border border-border border-b-transparent',
            tab.pinned && 'min-w-9.5 max-w-9.5 pl-2 pr-2',
            isDragging && 'opacity-60'
          )}
          {...attributes}
          {...listeners}
          onClick={() => onSelect(tab.id)}
          onMouseDown={handleMouseDown}
          role="tab"
          aria-selected={active}
          title={title}
        >
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 shrink-0" />
          ) : (
            <Globe className="size-3.5 shrink-0" />
          )}
          {!tab.pinned && (
            <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">{title}</span>
          )}
          {!tab.pinned && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="inline-flex size-6 items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground cursor-pointer shrink-0 hover:bg-accent hover:text-foreground"
              onClick={handleClose}
              onPointerDown={stopPointer}
              onMouseDown={stopPointer}
              aria-label={`Close ${title}`}
            >
              <X />
            </Button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onDuplicate(tab.id)}>Duplicate tab</ContextMenuItem>
        <ContextMenuItem onSelect={() => onPinToggle(tab.id, !tab.pinned)}>
          {tab.pinned ? <PinOff /> : <Pin />}
          {tab.pinned ? 'Unpin tab' : 'Pin tab'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onClose(tab.id)}>Close tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
TabItem.displayName = 'TabItem';

export const TabStrip = memo(({ tabset, onNewTab }: { tabset: BrowserTabset; onNewTab: () => void }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Pinned tabs render first, in their own stable order. Drag reorder
  // operates across the whole list but we sort so pinned stay leftmost.
  const orderedTabs = useMemo(() => {
    const pinned = tabset.tabs.filter((t) => t.pinned);
    const rest = tabset.tabs.filter((t) => !t.pinned);
    return [...pinned, ...rest];
  }, [tabset.tabs]);

  const handleSelect = useCallback(
    (id: BrowserTabId) => {
      void browserApi.activateTab(tabset.id, id);
    },
    [tabset.id]
  );

  const handleClose = useCallback(
    (id: BrowserTabId) => {
      void browserApi.closeTab(tabset.id, id);
    },
    [tabset.id]
  );

  const handlePinToggle = useCallback(
    (id: BrowserTabId, pinned: boolean) => {
      void browserApi.pinTab(tabset.id, id, pinned);
    },
    [tabset.id]
  );

  const handleDuplicate = useCallback(
    (id: BrowserTabId) => {
      void browserApi.duplicateTab(tabset.id, id);
    },
    [tabset.id]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const ids = orderedTabs.map((t) => t.id);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) {
        return;
      }
      const next = arrayMove(ids, oldIndex, newIndex);
      void browserApi.reorderTabs(tabset.id, next);
    },
    [orderedTabs, tabset.id]
  );

  return (
    <div
      className="flex items-stretch min-h-8.5 pl-1 pr-1 gap-0.5 border-b border-border bg-card overflow-x-auto overflow-y-hidden scrollbar-thin"
      role="tablist"
    >
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedTabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {orderedTabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === tabset.activeTabId}
              onSelect={handleSelect}
              onClose={handleClose}
              onPinToggle={handlePinToggle}
              onDuplicate={handleDuplicate}
            />
          ))}
        </SortableContext>
      </DndContext>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mt-1 ml-1 size-6.5 shrink-0"
        aria-label="New tab"
        onClick={onNewTab}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
});
TabStrip.displayName = 'TabStrip';
