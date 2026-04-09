import { DndContext, PointerSensor, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiArrowsInBold, PiArrowsOutBold, PiCodeBold, PiDotsSixVerticalBold, PiDotsThreeOutline, PiGitBranchBold, PiMonitorBold, PiPlusBold } from 'react-icons/pi';

import { uuidv4 } from '@/lib/uuid';
import { Button, cn, SegmentedControl } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeLayoutMode, CodeTab, CodeTabId, TicketId, TicketResolution } from '@/shared/types';

import { CodeTabContent } from './CodeTabContent';
import { TicketBannerActions, TicketColumnBadge, TicketResolutionBadge } from '@/renderer/features/Tickets/TicketControls';
import { type TicketPanel, TicketPanelOverlay } from '@/renderer/features/Tickets/TicketPanelOverlay';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { $codeTabStatuses, codeApi } from './state';

const COLUMN_WIDTH = 480;
const EXPANDED_COLUMN_WIDTH = 860;
const COMPACT_WIDTH = 900;

const CodeDeckHeader = memo(
  ({ layoutMode, onLayoutMode, onNewSession }: { layoutMode: CodeLayoutMode; onLayoutMode: (mode: CodeLayoutMode) => void; onNewSession: () => void }) => {
    return (
      <div className="hidden sm:flex h-10 items-center justify-end px-3 border-b border-surface-border bg-surface-raised">
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={layoutMode}
            options={[{ value: 'deck', label: 'Deck' }, { value: 'focus', label: 'Focus' }]}
            onChange={onLayoutMode}
            layoutId="code-layout-toggle"
          />
          <Button size="sm" variant="ghost" leftIcon={<PiPlusBold size={13} />} onClick={onNewSession}>
            New Session
          </Button>
        </div>
      </div>
    );
  }
);
CodeDeckHeader.displayName = 'CodeDeckHeader';

const SessionActionButton = memo(
  ({ icon, label, isDisabled, onClick }: { icon: React.ReactNode; label: string; isDisabled?: boolean; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }) => {
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

const RESOLUTIONS: { value: TicketResolution; label: string }[] = [
  { value: 'completed', label: 'Close as Completed' },
  { value: 'wont_do', label: "Close as Won't do" },
  { value: 'duplicate', label: 'Close as Duplicate' },
  { value: 'cancelled', label: 'Close as Cancelled' },
];

const MENU_DIVIDER = <div className="my-1 border-t border-surface-border" />;

const CodeSessionHeader = memo(
  ({
    label,
    ticketTitle,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onClose,
    dragHandle,
    ticketId,
    onOpenPanel,
  }: {
    label: string;
    ticketTitle?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onClose?: () => void;
    dragHandle?: React.ReactNode;
    ticketId?: TicketId;
    onOpenPanel?: (panel: TicketPanel) => void;
  }) => {
    const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
      if (!menuPosition) return;
      const handleClick = () => setMenuPosition(null);
      const handleKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setMenuPosition(null);
        }
      };
      window.addEventListener('click', handleClick);
      window.addEventListener('keydown', handleKey);
      return () => {
        window.removeEventListener('click', handleClick);
        window.removeEventListener('keydown', handleKey);
      };
    }, [menuPosition]);

    const handleOpenPanel = useCallback(
      (panel: TicketPanel) => {
        setMenuPosition(null);
        onOpenPanel?.(panel);
      },
      [onOpenPanel]
    );

    const handleResolve = useCallback(
      (resolution: TicketResolution) => {
        if (ticketId) {
          ticketApi.resolveTicket(ticketId, resolution);
        }
        setMenuPosition(null);
      },
      [ticketId]
    );

    return (
      <>
        <div className="relative flex items-center justify-between px-3 py-2 border-b border-surface-border bg-surface">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            <span className="text-sm font-medium text-fg truncate">{label}</span>
          </div>
          <div className="flex items-center gap-1">
            {actions}
            {onClose && (
              <SessionActionButton
                icon={<PiDotsThreeOutline size={16} />}
                label="Session menu"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenuPosition({ x: rect.right, y: rect.bottom + 6 });
                }}
              />
            )}
          </div>
          {menuPosition && onClose && (
            <div
              className="fixed z-50 min-w-[160px] rounded-md border border-surface-border bg-surface shadow-lg py-1"
              style={{ left: menuPosition.x - 160, top: menuPosition.y }}
            >
              {ticketId && onOpenPanel && (
                <>
                  <button type="button" onClick={() => handleOpenPanel('overview')} className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors">
                    Overview
                  </button>
                  <button type="button" onClick={() => handleOpenPanel('pr')} className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors">
                    PR
                  </button>
                  <button type="button" onClick={() => handleOpenPanel('artifacts')} className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors">
                    Artifacts
                  </button>
                  {MENU_DIVIDER}
                </>
              )}
              {ticketId && (
                <>
                  {RESOLUTIONS.map((res) => (
                    <button
                      key={res.value}
                      type="button"
                      onClick={() => handleResolve(res.value)}
                      className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors"
                    >
                      {res.label}
                    </button>
                  ))}
                  {MENU_DIVIDER}
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuPosition(null);
                  onClose();
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors"
              >
                Close session
              </button>
            </div>
          )}
        </div>
        {ticketTitle && (
          <div className="flex items-center justify-between px-3 sm:px-5 py-1.5 border-b border-surface-border bg-surface-raised/50">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-fg-muted truncate">{ticketTitle}</span>
              <span className="hidden sm:flex items-center gap-2 shrink-0">
                {ticketColumnBadge}
                {ticketMetaBadge}
              </span>
            </div>
            {ticketActions && <div className="hidden sm:flex items-center gap-1.5 shrink-0 ml-2">{ticketActions}</div>}
          </div>
        )}
      </>
    );
  }
);
CodeSessionHeader.displayName = 'CodeSessionHeader';

const DeckColumn = memo(
  ({
    tab,
    label,
    ticketTitle,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onClose,
    isExpanded,
    onToggleExpand,
    children,
    headerActionsSlot,
  }: {
    tab: CodeTab;
    label: string;
    ticketTitle?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onClose: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
    children: React.ReactNode;
    headerActionsSlot?: React.ReactNode;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn('flex h-full flex-col border-r border-surface-border bg-surface-raised', isDragging && 'opacity-70')}
      >
        <CodeSessionHeader
          label={label}
          ticketTitle={ticketTitle}
          ticketColumnBadge={ticketColumnBadge}
          ticketMetaBadge={ticketMetaBadge}
          ticketActions={ticketActions}
          actions={
            <div className="flex items-center gap-1">
              {headerActionsSlot}
              {actions}
              <SessionActionButton
                icon={isExpanded ? <PiArrowsInBold size={15} /> : <PiArrowsOutBold size={15} />}
                label={isExpanded ? 'Collapse column' : 'Expand column'}
                onClick={() => onToggleExpand(tab.id)}
              />
            </div>
          }
          onClose={() => onClose(tab.id)}
          ticketId={tab.ticketId as TicketId | undefined}
          onOpenPanel={tab.ticketId ? setActivePanel : undefined}
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
        <div className="flex-1 min-h-0 relative">
          {children}
          {tab.ticketId && (
            <TicketPanelOverlay panel={activePanel} ticketId={tab.ticketId as TicketId} onClose={handleClosePanel} />
          )}
        </div>
      </div>
    );
  }
);
DeckColumn.displayName = 'DeckColumn';

const CodeSessionPane = memo(
  ({
    tab,
    label,
    ticketTitle,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onClose,
    isVisible,
    overlayPane,
    onCloseOverlay,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    hideHeaderOnMobile,
  }: {
    tab: CodeTab;
    label: string;
    ticketTitle?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onClose: (id: CodeTabId) => void;
    isVisible: boolean;
    overlayPane: 'none' | 'code' | 'vnc';
    onCloseOverlay: () => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    /** Hide the session header row on mobile (used in paged mode where the session bar already identifies the session) */
    hideHeaderOnMobile?: boolean;
  }) => {
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);

    return (
      <div className={cn('w-full h-full flex flex-col bg-surface-raised', !isVisible && 'hidden')}>
        <div className={cn(hideHeaderOnMobile && 'hidden sm:block')}>
        <CodeSessionHeader
          label={label}
          ticketTitle={ticketTitle}
          ticketColumnBadge={ticketColumnBadge}
          ticketMetaBadge={ticketMetaBadge}
          ticketActions={ticketActions}
          actions={actions}
          onClose={() => onClose(tab.id)}
          ticketId={tab.ticketId as TicketId | undefined}
          onOpenPanel={tab.ticketId ? setActivePanel : undefined}
        />
        </div>
        <div className="flex-1 min-h-0 relative">
          <CodeTabContent
            tab={tab}
            isVisible={isVisible}
            overlayPane={overlayPane}
            onCloseOverlay={onCloseOverlay}
            uiMinimal={uiMinimal}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
          />
          {tab.ticketId && (
            <TicketPanelOverlay panel={activePanel} ticketId={tab.ticketId as TicketId} onClose={handleClosePanel} />
          )}
        </div>
      </div>
    );
  }
);
CodeSessionPane.displayName = 'CodeSessionPane';

const FocusListItem = memo(
  ({ tab, label, subLabel, isActive, onSelect, onClose }: { tab: CodeTab; label: string; subLabel?: string | null; isActive: boolean; onSelect: (id: CodeTabId) => void; onClose: (id: CodeTabId) => void }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    useEffect(() => {
      if (!menuPosition) return;
      const handleClick = () => setMenuPosition(null);
      const handleKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setMenuPosition(null);
        }
      };
      window.addEventListener('click', handleClick);
      window.addEventListener('keydown', handleKey);
      return () => {
        window.removeEventListener('click', handleClick);
        window.removeEventListener('keydown', handleKey);
      };
    }, [menuPosition]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('group relative', isDragging && 'opacity-70')}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className={cn(
          'flex items-center gap-3 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
          isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )}
      >
        <button
          type="button"
          className="inline-flex items-center justify-center size-8 rounded-lg text-fg-muted hover:text-fg hover:bg-white/5"
          {...attributes}
          {...listeners}
          aria-label="Reorder"
        >
          <PiDotsSixVerticalBold size={14} />
        </button>
        <button type="button" onClick={() => onSelect(tab.id)} className="flex-1 min-w-0 text-left">
          <div className="flex flex-col min-w-0">
            <span className="text-sm truncate">{label}</span>
            {subLabel && <span className="text-xs text-fg-subtle truncate">{subLabel}</span>}
          </div>
        </button>
        <SessionActionButton
          icon={<PiDotsThreeOutline size={16} />}
          label="Session menu"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenuPosition({ x: rect.left, y: rect.bottom + 6 });
          }}
        />
      </div>
      {menuPosition && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-surface-border bg-surface shadow-lg py-1"
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <button
            type="button"
            onClick={() => {
              setMenuPosition(null);
              onClose(tab.id);
            }}
            className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover transition-colors"
          >
            Delete session
          </button>
        </div>
      )}
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
  const [expandedTabId, setExpandedTabId] = useState<CodeTabId | null>(null);

  const addingFirstTab = useRef(false);
  useEffect(() => {
    if (tabs.length === 0 && !addingFirstTab.current) {
      addingFirstTab.current = true;
      codeApi.addTab().finally(() => { addingFirstTab.current = false; });
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

  useEffect(() => {
    if (expandedTabId && !tabs.some((tab) => tab.id === expandedTabId)) {
      setExpandedTabId(null);
    }
  }, [expandedTabId, tabs]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectMap = useMemo(() => {
    const map = new Map<string, { label: string; workspaceDir: string }>();
    for (const p of store.projects) {
      map.set(p.id, { label: p.label, workspaceDir: p.workspaceDir });
    }
    return map;
  }, [store.projects]);

  const resolveLabel = useCallback(
    (tab: CodeTab) => {
      if (!tab.projectId) return 'New Session';
      return projectMap.get(tab.projectId)?.label ?? 'Unknown';
    },
    [projectMap]
  );

  const resolveTicketTitle = useCallback(
    (tab: CodeTab) => tab.ticketTitle ?? null,
    []
  );

  const resolveSubLabel = useCallback(
    (tab: CodeTab) => {
      if (!tab.projectId) return null;
      const workspaceDir = projectMap.get(tab.projectId)?.workspaceDir;
      if (!workspaceDir) return null;
      const segments = workspaceDir.split('/').filter(Boolean);
      return segments.slice(-2).join('/');
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

  const handleToggleExpand = useCallback((id: CodeTabId) => {
    setExpandedTabId((current) => (current === id ? null : id));
  }, []);

  const handleClose = useCallback((id: CodeTabId) => {
    setOverlayTarget((current) => (current?.tabId === id ? null : current));
    setExpandedTabId((current) => (current === id ? null : current));
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable = target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      if (isEditable) return;
      if (!activeTabId) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setExpandedTabId((current) => (current === activeTabId ? null : activeTabId));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId]);

  const handleNewTabSession = useCallback(
    (tab: CodeTab) => {
      codeApi.setTabSessionId(tab.id, uuidv4());
    },
    []
  );

  const renderSessionActions = useCallback(
    (tab: CodeTab) => {
      const newSessionBtn = (
        <SessionActionButton
          icon={<PiPlusBold size={13} />}
          label="New session"
          onClick={() => handleNewTabSession(tab)}
        />
      );
      const status = statuses[tab.id];
      const isRunning = status?.type === 'running';
      const codeServerUrl = isRunning ? status.data.codeServerUrl : undefined;
      const vncUrl = isRunning ? status.data.noVncUrl : undefined;
      return (
        <>
          {newSessionBtn}
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
    [handleOpenOverlay, handleNewTabSession, statuses]
  );

  const renderTicketColumnBadge = useCallback(
    (tab: CodeTab) => {
      if (!tab.ticketId) return undefined;
      return <TicketColumnBadge ticketId={tab.ticketId} />;
    },
    []
  );

  const renderTicketBannerActions = useCallback(
    (tab: CodeTab) => {
      if (!tab.ticketId) return undefined;
      return (
        <>
          <TicketBannerActions ticketId={tab.ticketId} />
          <TicketResolutionBadge ticketId={tab.ticketId} />
        </>
      );
    },
    []
  );

  const renderTicketMetaBadge = useCallback(
    (tab: CodeTab) => {
      if (!tab.ticketId) {
        return undefined;
      }

      const ticket = store.tickets.find((item) => item.id === tab.ticketId);
      if (!ticket) {
        return undefined;
      }

      const initiative = store.initiatives.find((item) => item.id === ticket.initiativeId);
      const effectiveBranch = ticket.branch ?? initiative?.branch;
      const projectWorkspaceDir = tab.projectId ? projectMap.get(tab.projectId)?.workspaceDir : undefined;
      const isIsolatedWorkspace = !!tab.workspaceDir && !!projectWorkspaceDir && tab.workspaceDir !== projectWorkspaceDir;

      if (!effectiveBranch && !isIsolatedWorkspace) {
        return undefined;
      }

      return (
        <span className="flex items-center gap-1 rounded-full bg-purple-400/10 px-1.5 py-0.5 text-xs font-medium text-purple-400 shrink-0">
          <PiGitBranchBold size={10} />
          {effectiveBranch ?? 'Isolated workspace'}
          {isIsolatedWorkspace ? ' · isolated' : ''}
          {!ticket.branch && initiative?.branch ? ' · inherited' : ''}
        </span>
      );
    },
    [projectMap, store.initiatives, store.tickets]
  );

  return (
    <div className="flex flex-col w-full h-full min-h-0 overflow-hidden">
      <CodeDeckHeader layoutMode={layoutMode} onLayoutMode={handleLayoutMode} onNewSession={handleNewSession} />
      {derivedLayout === 'deck' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
              <div className="flex h-full min-w-max overflow-y-hidden">
                {tabs.map((tab) => {
                  return (
                    <div
                      key={tab.id}
                      style={{ width: expandedTabId === tab.id ? EXPANDED_COLUMN_WIDTH : COLUMN_WIDTH }}
                      className="h-full flex-shrink-0"
                    >
                      <DeckColumn
                        tab={tab}
                        label={resolveLabel(tab)}
                        ticketTitle={resolveTicketTitle(tab)}
                        ticketColumnBadge={renderTicketColumnBadge(tab)}
                        ticketMetaBadge={renderTicketMetaBadge(tab)}
                        ticketActions={renderTicketBannerActions(tab)}
                        actions={renderSessionActions(tab)}
                        onClose={handleClose}
                        isExpanded={expandedTabId === tab.id}
                        onToggleExpand={handleToggleExpand}
                        headerActionsSlot={<div id={`code-deck-header-actions-${tab.id}`} />}
                      >
                        <CodeTabContent
                          tab={tab}
                          isVisible
                          overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                          onCloseOverlay={handleCloseOverlay}
                          uiMinimal
                          headerActionsTargetId={`code-deck-header-actions-${tab.id}`}
                          headerActionsCompact
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
              <div className="flex flex-col h-full w-60 border-r border-surface-border bg-surface shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border">
                  <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Sessions</span>
                  {tabs.length > 0 && <span className="text-xs text-fg-subtle">{tabs.length}</span>}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto py-1">
                  {tabs.map((tab) => (
                    <FocusListItem
                      key={tab.id}
                      tab={tab}
                      label={resolveLabel(tab)}
                      subLabel={resolveTicketTitle(tab) ?? resolveSubLabel(tab)}
                      isActive={tab.id === activeTab?.id}
                      onSelect={handleSelect}
                      onClose={handleClose}
                    />
                  ))}
                </div>
              </div>
              <div className="flex-1 min-w-0 min-h-0">
                {tabs.map((tab) => (
                    <CodeSessionPane
                      key={tab.id}
                      tab={tab}
                      label={resolveLabel(tab)}
                      ticketTitle={resolveTicketTitle(tab)}
                      ticketColumnBadge={renderTicketColumnBadge(tab)}
                      ticketMetaBadge={renderTicketMetaBadge(tab)}
                      ticketActions={renderTicketBannerActions(tab)}
                      actions={renderSessionActions(tab)}
                      onClose={handleClose}
                      isVisible={tab.id === activeTab?.id}
                      overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                      onCloseOverlay={handleCloseOverlay}
                      uiMinimal={false}
                      headerActionsTargetId={undefined}
                      headerActionsCompact={false}
                    />
                ))}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      )}
      {derivedLayout === 'paged' && activeTab && (
        <div className="flex-1 min-h-0 flex flex-col relative">
          {/* Mobile: horizontal scrollable tab bar */}
          <div className="sm:hidden flex items-center border-b border-surface-border bg-surface-raised overflow-x-auto">
            <div className="flex items-center gap-1 px-2 py-1.5">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleSelect(tab.id)}
                  className={cn(
                    'shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors',
                    tab.id === activeTab.id
                      ? 'bg-accent-600/20 text-accent-400'
                      : 'bg-surface-overlay text-fg-muted active:bg-surface-border'
                  )}
                >
                  {resolveLabel(tab)}
                </button>
              ))}
              <button
                type="button"
                onClick={handleNewSession}
                className="shrink-0 size-9 rounded-full bg-surface-overlay text-fg-muted flex items-center justify-center active:bg-surface-border transition-colors"
                aria-label="New session"
              >
                <PiPlusBold size={13} />
              </button>
            </div>
          </div>
          {/* Desktop: select dropdown + prev/next */}
          <div className="hidden sm:flex items-center justify-between px-4 py-2 border-b border-surface-border bg-surface-raised text-xs text-fg-muted">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0">Session</span>
              <select
                value={activeTab.id}
                onChange={(e) => handleSelect(e.target.value)}
                className="bg-surface border border-surface-border rounded-md px-2 py-1 text-xs text-fg min-w-0 truncate"
              >
                {tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {resolveLabel(tab)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 shrink-0">
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
                  ticketTitle={resolveTicketTitle(tab)}
                  ticketColumnBadge={renderTicketColumnBadge(tab)}
                  ticketMetaBadge={renderTicketMetaBadge(tab)}
                  actions={renderSessionActions(tab)}
                  onClose={handleClose}
                  isVisible={tab.id === activeTab.id}
                  overlayPane={overlayTarget?.tabId === tab.id ? overlayTarget.pane : 'none'}
                  onCloseOverlay={handleCloseOverlay}
                  uiMinimal={false}
                  headerActionsTargetId={undefined}
                  headerActionsCompact={false}
                  hideHeaderOnMobile
                />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
CodeDeck.displayName = 'CodeDeck';
