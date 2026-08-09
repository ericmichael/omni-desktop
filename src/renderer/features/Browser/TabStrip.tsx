import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Globe, Pin, PinOff, Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';

import { fallbackTitle } from '@/lib/url';
import { ClosableTabChip } from '@/renderer/ds/ClosableTabs';
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
  const handleClose = useCallback(() => onClose(tab.id), [onClose, tab.id]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Behavior (drag reorder, pinning, context menu) lives here; the
            chip owns the look, middle-click close, and the close button's
            pointer isolation from dnd-kit's sortable listeners. */}
        <ClosableTabChip
          ref={setNodeRef}
          style={style}
          active={active}
          label={title}
          icon={
            tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0" />
            ) : (
              <Globe className="size-3.5 shrink-0" />
            )
          }
          iconOnly={tab.pinned}
          onClose={handleClose}
          className={cn(tab.pinned && 'w-9.5', isDragging && 'opacity-60')}
          {...attributes}
          {...listeners}
          tabIndex={active ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        />
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
  const stripRef = useRef<HTMLDivElement>(null);

  // Roving-tabindex tablist: Tab lands on the active tab; arrows move
  // focus between tabs, Enter/Space (handled by the chip) activates.
  const handleStripKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const tabs = stripRef.current ? [...stripRef.current.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
    if (tabs.length === 0) {
      return;
    }
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowLeft'
            ? current <= 0
              ? tabs.length - 1
              : current - 1
            : current < 0 || current === tabs.length - 1
              ? 0
              : current + 1;
    event.preventDefault();
    tabs[next]?.focus();
  }, []);

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
      ref={stripRef}
      className="flex items-center min-h-9 pl-2 pr-2 gap-1.5 bg-card overflow-x-auto overflow-y-hidden scrollbar-thin"
      role="tablist"
      onKeyDown={handleStripKeyDown}
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
        className="ml-1 size-6.5 shrink-0"
        aria-label="New tab"
        onClick={onNewTab}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
});
TabStrip.displayName = 'TabStrip';
