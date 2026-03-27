import { DndContext, PointerSensor, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiCodeBold, PiDotsSixVerticalBold, PiMonitorBold, PiPlusBold } from 'react-icons/pi';

import { Button, IconButton, cn } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeLayoutMode, CodeTab, CodeTabId } from '@/shared/types';

import { CodeTabContent } from './CodeTabContent';
import { $codeTabStatuses, codeApi } from './state';

const COLUMN_WIDTH = 480;
const COMPACT_WIDTH = 900;

const CodeDeckHeader = memo(
  ({ layoutMode, onLayoutMode, onNewSession }: { layoutMode: CodeLayoutMode; onLayoutMode: (mode: CodeLayoutMode) => void; onNewSession: () => void }) => {
    return (
      <div className="flex h-10 items-center justify-end px-3 border-b border-surface-border bg-surface-raised">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md bg-surface-overlay p-0.5">
            <button
              type="button"
              onClick={() => onLayoutMode('deck')}
              className={cn(
                'px-2 py-1 text-[11px] rounded-sm transition-colors',
                layoutMode === 'deck' ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-border/40'
              )}
            >
              Deck
            </button>
            <button
              type="button"
              onClick={() => onLayoutMode('focus')}
              className={cn(
                'px-2 py-1 text-[11px] rounded-sm transition-colors',
                layoutMode === 'focus' ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-border/40'
              )}
            >
              Focus
            </button>
          </div>
          <Button size="sm" variant="ghost" leftIcon={<PiPlusBold size={13} />} onClick={onNewSession} className="h-7 px-2.5 text-[11px]">
            New Session
          </Button>
        </div>
      </div>
    );
  }
);
CodeDeckHeader.displayName = 'CodeDeckHeader';

const SessionActionButton = memo(
  ({ icon, label, isDisabled, onClick }: { icon: React.ReactNode; label: string; isDisabled?: boolean; onClick?: () => void }) => {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={isDisabled}
        onClick={onClick}
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-md text-fg-muted transition-colors',
          'hover:bg-white/5 hover:text-fg',
          isDisabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-fg-muted'
        )}
      >
        {icon}
      </button>
    );
  }
);
SessionActionButton.displayName = 'SessionActionButton';

const CodeSessionHeader = memo(
  ({
    label,
    isRunning,
    actions,
    onClose,
    dragHandle,
  }: {
    label: string;
    isRunning: boolean;
    actions?: React.ReactNode;
    onClose?: () => void;
    dragHandle?: React.ReactNode;
  }) => {
    return (
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border bg-surface">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('size-2 rounded-full', isRunning ? 'bg-green-400' : 'bg-surface-border')} />
          <span className="text-sm font-medium text-fg truncate">{label}</span>
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {onClose && <IconButton aria-label="Close session" icon={<PiPlusBold className="rotate-45" />} size="sm" onClick={onClose} />}
          {dragHandle}
        </div>
      </div>
    );
  }
);
CodeSessionHeader.displayName = 'CodeSessionHeader';

const DeckColumn = memo(
  ({
    tab,
    label,
    isRunning,
    actions,
    onClose,
    children,
  }: {
    tab: CodeTab;
    label: string;
    isRunning: boolean;
    actions?: React.ReactNode;
    onClose: (id: CodeTabId) => void;
    children: React.ReactNode;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn('flex h-full flex-col border-r border-surface-border bg-surface-raised', isDragging && 'opacity-70')}
      >
        <CodeSessionHeader
          label={label}
          isRunning={isRunning}
          actions={actions}
          onClose={() => onClose(tab.id)}
          dragHandle={
            <button
              type="button"
              className="inline-flex items-center justify-center size-8 rounded-md text-fg-muted hover:text-fg hover:bg-white/5"
              {...attributes}
              {...listeners}
              aria-label="Reorder"
            >
              <PiDotsSixVerticalBold size={16} />
            </button>
          }
        />
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    );
  }
);
DeckColumn.displayName = 'DeckColumn';

const CodeSessionPane = memo(
  ({
    tab,
    label,
    isRunning,
    actions,
    onClose,
    isVisible,
    overlayPane,
    onCloseOverlay,
  }: {
    tab: CodeTab;
    label: string;
    isRunning: boolean;
    actions?: React.ReactNode;
    onClose: (id: CodeTabId) => void;
    isVisible: boolean;
    overlayPane: 'none' | 'code' | 'vnc';
    onCloseOverlay: () => void;
  }) => {
    return (
      <div className={cn('w-full h-full flex flex-col bg-surface-raised', !isVisible && 'hidden')}>
        <CodeSessionHeader label={label} isRunning={isRunning} actions={actions} onClose={() => onClose(tab.id)} />
        <div className="flex-1 min-h-0">
          <CodeTabContent tab={tab} isVisible={isVisible} overlayPane={overlayPane} onCloseOverlay={onCloseOverlay} />
        </div>
      </div>
    );
  }
);
CodeSessionPane.displayName = 'CodeSessionPane';

const FocusListItem = memo(
  ({ tab, label, isActive, isRunning, onSelect, onClose }: { tab: CodeTab; label: string; isActive: boolean; isRunning: boolean; onSelect: (id: CodeTabId) => void; onClose: (id: CodeTabId) => void }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    return (
      <div ref={setNodeRef} style={style} className={cn('group', isDragging && 'opacity-70')}>
        <button
          type="button"
          onClick={() => onSelect(tab.id)}
          className={cn(
            'w-full text-left px-3 py-2 rounded-lg border transition-colors flex items-center justify-between gap-2',
            isActive ? 'bg-surface border-accent-500/40 text-fg' : 'bg-surface-overlay border-transparent text-fg-muted hover:text-fg hover:border-surface-border'
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn('size-2 rounded-full', isRunning ? 'bg-green-400' : 'bg-surface-border')} />
            <span className="text-xs font-medium truncate">{label}</span>
          </div>
          <div className="flex items-center gap-1">
            <IconButton
              aria-label="Close session"
              icon={<PiPlusBold className="rotate-45" />}
              size="sm"
              onClick={() => onClose(tab.id)}
              className={cn('!size-6', isActive ? 'opacity-80' : 'opacity-0 group-hover:opacity-80')}
            />
            <button
              type="button"
              className="inline-flex items-center justify-center size-6 rounded-md text-fg-muted hover:text-fg hover:bg-white/5"
              {...attributes}
              {...listeners}
              aria-label="Reorder"
            >
              <PiDotsSixVerticalBold size={14} />
            </button>
          </div>
        </button>
      </div>
    );
  }
);
FocusListItem.displayName = 'FocusListItem';

export const CodeDeck = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const statuses = useStore($codeTabStatuses);
  const tabs = store.codeTabs ?? [];
  const layoutMode = store.codeLayoutMode ?? 'deck';
  const activeTabId = store.activeCodeTabId ?? tabs[0]?.id ?? null;
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < COMPACT_WIDTH);
  const [overlayTarget, setOverlayTarget] = useState<{ tabId: CodeTabId; pane: 'code' | 'vnc' } | null>(null);

  useEffect(() => {
    if (tabs.length === 0) {
      codeApi.addTab();
    }
  }, [tabs.length]);

  useEffect(() => {
    const firstTab = tabs[0];
    if (!activeTabId && firstTab) {
      codeApi.setActiveTab(firstTab.id);
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    const handler = () => {
      setIsCompact(window.innerWidth < COMPACT_WIDTH);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of store.fleetProjects) {
      map.set(p.id, p.label);
    }
    return map;
  }, [store.fleetProjects]);

  const resolveLabel = useCallback(
    (tab: CodeTab) => {
      if (!tab.projectId) return 'New Session';
      return projectMap.get(tab.projectId) ?? 'Unknown';
    },
    [projectMap]
  );

  const handleLayoutMode = useCallback(
    (mode: CodeLayoutMode) => {
      codeApi.setLayoutMode(mode);
    },
    []
  );

  const handleNewSession = useCallback(() => {
    codeApi.addTab();
  }, []);

  const handleSelect = useCallback((id: CodeTabId) => {
    codeApi.setActiveTab(id);
  }, []);

  const handleClose = useCallback((id: CodeTabId) => {
    setOverlayTarget((current) => (current?.tabId === id ? null : current));
    codeApi.removeTab(id);
  }, []);

  const handleOpenOverlay = useCallback((tabId: CodeTabId, pane: 'code' | 'vnc') => {
    setOverlayTarget({ tabId, pane });
  }, []);

  const handleCloseOverlay = useCallback(() => {
    setOverlayTarget(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) {
        return;
      }
      const nextTabs = arrayMove(tabs, oldIndex, newIndex);
      codeApi.reorderTabs(nextTabs);
    },
    [tabs]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const derivedLayout: CodeLayoutMode | 'paged' = isCompact ? 'paged' : layoutMode;

  const renderSessionActions = useCallback(
    (tab: CodeTab) => {
      const status = statuses[tab.id];
      const isRunning = status?.type === 'running';
      const codeServerUrl = isRunning ? status.data.codeServerUrl : undefined;
      const vncUrl = isRunning ? status.data.noVncUrl : undefined;
      return (
        <>
          <SessionActionButton
            icon={<PiCodeBold size={15} />}
            label="Expand VS Code"
            isDisabled={!codeServerUrl}
            onClick={codeServerUrl ? () => handleOpenOverlay(tab.id, 'code') : undefined}
          />
          <SessionActionButton
            icon={<PiMonitorBold size={15} />}
            label="Expand Desktop"
            isDisabled={!vncUrl}
            onClick={vncUrl ? () => handleOpenOverlay(tab.id, 'vnc') : undefined}
          />
        </>
      );
    },
    [handleOpenOverlay, statuses]
  );

  return (
    <div className="flex flex-col w-full h-full">
      <CodeDeckHeader layoutMode={layoutMode} onLayoutMode={handleLayoutMode} onNewSession={handleNewSession} />
      {derivedLayout === 'deck' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div className="flex-1 min-h-0 overflow-x-auto">
              <div className="flex h-full min-w-max">
                {tabs.map((tab) => {
                  const status = statuses[tab.id];
                  const isRunning = status?.type === 'running';
                  return (
                    <div key={tab.id} style={{ width: COLUMN_WIDTH }} className="h-full flex-shrink-0">
                      <DeckColumn
                        tab={tab}
                        label={resolveLabel(tab)}
                        isRunning={isRunning}
                        actions={renderSessionActions(tab)}
                        onClose={handleClose}
                      >
                        <CodeTabContent
                          tab={tab}
                          isVisible
                          overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                          onCloseOverlay={handleCloseOverlay}
                        />
                      </DeckColumn>
                    </div>
                  );
                })}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      )}
      {derivedLayout === 'focus' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="flex-1 min-h-0 flex">
              <div className="w-64 border-r border-surface-border bg-surface-raised px-3 py-3 flex flex-col gap-2">
                {tabs.map((tab) => {
                  const status = statuses[tab.id];
                  const isRunning = status?.type === 'running';
                  return (
                    <FocusListItem
                      key={tab.id}
                      tab={tab}
                      label={resolveLabel(tab)}
                      isActive={tab.id === activeTab?.id}
                      isRunning={isRunning}
                      onSelect={handleSelect}
                      onClose={handleClose}
                    />
                  );
                })}
              </div>
              <div className="flex-1 min-w-0 min-h-0">
                {tabs.map((tab) => (
                  <CodeSessionPane
                    key={tab.id}
                    tab={tab}
                    label={resolveLabel(tab)}
                    isRunning={statuses[tab.id]?.type === 'running'}
                    actions={renderSessionActions(tab)}
                    onClose={handleClose}
                    isVisible={tab.id === activeTab?.id}
                    overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                    onCloseOverlay={handleCloseOverlay}
                  />
                ))}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      )}
      {derivedLayout === 'paged' && activeTab && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-surface-border bg-surface-raised text-xs text-fg-muted">
            <div className="flex items-center gap-2">
              <span>Session</span>
              <select
                value={activeTab.id}
                onChange={(e) => handleSelect(e.target.value)}
                className="bg-surface border border-surface-border rounded-md px-2 py-1 text-xs text-fg"
              >
                {tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {resolveLabel(tab)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const index = tabs.findIndex((t) => t.id === activeTab.id);
                  const previousTab = index > 0 ? tabs[index - 1] : undefined;
                  if (previousTab) {
                    handleSelect(previousTab.id);
                  }
                }}
                isDisabled={tabs.findIndex((t) => t.id === activeTab.id) <= 0}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const index = tabs.findIndex((t) => t.id === activeTab.id);
                  const nextTab = index >= 0 && index < tabs.length - 1 ? tabs[index + 1] : undefined;
                  if (nextTab) {
                    handleSelect(nextTab.id);
                  }
                }}
                isDisabled={tabs.findIndex((t) => t.id === activeTab.id) >= tabs.length - 1}
              >
                Next
              </Button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {tabs.map((tab) => (
              <CodeSessionPane
                key={tab.id}
                tab={tab}
                label={resolveLabel(tab)}
                isRunning={statuses[tab.id]?.type === 'running'}
                actions={renderSessionActions(tab)}
                onClose={handleClose}
                isVisible={tab.id === activeTab.id}
                overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                onCloseOverlay={handleCloseOverlay}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
CodeDeck.displayName = 'CodeDeck';
