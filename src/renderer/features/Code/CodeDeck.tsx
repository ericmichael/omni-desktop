import './CodeDeck.css';

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '@nanostores/react';
import { LayoutGroup, motion } from 'framer-motion';
import {
  Archive,
  Columns3,
  Ellipsis,
  GitFork,
  Globe,
  GripVertical,
  LayoutGrid,
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelRight,
  Plus,
  RefreshCw,
  Scan,
  X,
} from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { customAppPartition } from '@/lib/app-partition';
import { Webview } from '@/renderer/common/Webview';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
/** Sentinel customAppId meaning "show the app launcher picker". */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { SidebarTrigger, useSidebar } from '@/renderer/ds/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { $appLaunchRequest, clearAppLaunchRequest } from '@/renderer/features/AppControl/app-launch-bridge';
import { BrowserView } from '@/renderer/features/Browser/BrowserView';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $previewRequest, clearPreviewRequest } from '@/renderer/features/Tickets/preview-bridge';
import { PullRequestBanner } from '@/renderer/features/Tickets/PullRequestBanner';
import { TicketBannerActions, TicketColumnBadge } from '@/renderer/features/Tickets/TicketControls';
import { type TicketPanel, TicketPanelOverlay } from '@/renderer/features/Tickets/TicketPanelOverlay';
import { $columnActivity, activityStatusText } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import { ENTER_ANIMATE, ENTER_INITIAL, FADE_DURATION_S, SPRING_GENTLE, SPRING_STANDARD } from '@/renderer/theme/motion';
import type { AppHandleScope } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { AppDescriptor, AppId, CustomAppEntry } from '@/shared/app-registry';
import { buildAppRegistry } from '@/shared/app-registry';
import type { AutoLaunchPhase } from '@/shared/machines/auto-launch.machine';
import type { CodeLayoutMode, CodeTab, CodeTabId, ProjectId, TicketId } from '@/shared/types';
import { firstSource, isChatColumn, projectHasRepoSource } from '@/shared/types';

import { AppIcon } from './AppIcon';
import { CodeTabContent } from './CodeTabContent';
import { ColumnAura } from './ColumnAura';
import { $codeTabPhases, $codeTabStatuses, APP_LAUNCHER_ID, codeApi } from './state';
import { useRecentConversations } from './use-recent-conversations';

const BROWSER_APP_ID = 'browser';
const BROWSER_START_URL = 'https://duckduckgo.com';

/**
 * Synthetic launcher entry for a global browser column. Rendered with a URL
 * bar (see `BrowserColumn`) instead of a plain webview — it's the "address-bar
 * browser" counterpart to per-session dock previews.
 */
const SYNTHETIC_BROWSER_APP: CustomAppEntry = {
  id: BROWSER_APP_ID,
  label: 'Browser',
  icon: 'Globe',
  url: BROWSER_START_URL,
  order: -1,
  columnScoped: false,
};

// URL normalization lives in `@/lib/url` so it's shared with the
// main-process BrowserManager and testable without the DOM.

const COLUMN_WIDTH = 480;
const COLUMN_WIDTH_SMALL = 360;
const LAUNCH_COLUMN_MAX_WIDTH = 640;
const EXPANDED_COLUMN_WIDTH = 860;
/** Resize bounds for a deck column (desktop). */
const MIN_COLUMN_WIDTH = 320;
const MAX_COLUMN_WIDTH = 960;
/** Below this width, deck columns use COLUMN_WIDTH_SMALL. */
const NARROW_DECK_WIDTH = 800;
/** Below this width, deck columns snap-scroll at ~92% viewport width. */
const SNAP_SCROLL_WIDTH = 540;

const spacesWidthsFromTabs = (tabs: CodeTab[]): Record<CodeTabId, number> => {
  const widths: Record<CodeTabId, number> = {};
  for (const tab of tabs) {
    if (tab.spacesWidth !== undefined) {
      widths[tab.id] = tab.spacesWidth;
    }
    if (tab.spacesSidecarWidth !== undefined) {
      widths[`sidecar:${tab.id}`] = tab.spacesSidecarWidth;
    }
  }
  return widths;
};

const spacesExpandedFromTabs = (tabs: CodeTab[]): ReadonlySet<CodeTabId> => {
  const expanded = new Set<CodeTabId>();
  for (const tab of tabs) {
    if (tab.spacesExpanded) {
      expanded.add(tab.id);
    }
    if (tab.spacesSidecarExpanded) {
      expanded.add(`sidecar:${tab.id}`);
    }
  }
  return expanded;
};

const CodeDeckHeader = memo(
  ({
    layoutMode,
    onOpenSpaces,
    onNewSession,
    onOpenApps,
  }: {
    layoutMode: CodeLayoutMode;
    onOpenSpaces: () => void;
    onNewSession: () => void;
    onOpenApps: () => void;
  }) => {
    const { isMobile, state: sidebarState } = useSidebar();
    const navigationHidden = isMobile || sidebarState === 'collapsed';

    return (
      <div className={cn('flex h-10 items-center justify-between pl-4 pr-4 border-b border-border bg-card')}>
        {navigationHidden && <SidebarTrigger className="-ml-1.5" size="icon-sm" aria-label="Open navigation" />}
        {layoutMode === 'tile' ? (
          <div className="flex items-center gap-2 text-sm font-medium" aria-label="Spaces workspace">
            <Columns3 className="size-4" />
            <span>Spaces</span>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={onOpenSpaces} title="Return to Spaces">
            <Columns3 className="size-4" />
            Spaces
          </Button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Plus className="size-4" />
                New
              </Button>
            </DropdownMenuTrigger>
            <>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={onNewSession}>
                  <MessageCircle className="mr-1.5 size-4 align-text-bottom" />
                  Chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onOpenApps}>
                  <LayoutGrid className="mr-1.5 size-4 align-text-bottom" />
                  Apps
                </DropdownMenuItem>
              </DropdownMenuContent>
            </>
          </DropdownMenu>
        </div>
      </div>
    );
  }
);
CodeDeckHeader.displayName = 'CodeDeckHeader';

/** Boot-phase wording for the status line (pre-chat sandbox lifecycle). */
const BOOT_PHASE_LABELS: Partial<Record<AutoLaunchPhase, string>> = {
  checking: 'Checking runtime…',
  installing: 'Installing runtime…',
  configChecking: 'Checking configuration…',
  starting: 'Starting sandbox…',
};

/** Re-render once a minute so relative "Started …" labels stay fresh. */
const useNowMinute = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

/**
 * Identity stamp for a session column. Relative while fresh, but past 24h it
 * includes the date + time of day — two columns started "yesterday" must not
 * collapse into the same label, since this line exists to tell them apart.
 */
const startedLabel = (tab: CodeTab): string | null => {
  if (!tab.createdAt) {
    return null;
  }
  const ageMs = Date.now() - tab.createdAt;
  const started = new Date(tab.createdAt);
  if (ageMs < 60_000) {
    return 'Started just now';
  }
  if (ageMs < 60 * 60_000) {
    return `Started ${Math.floor(ageMs / 60_000)}m ago`;
  }
  if (ageMs < 24 * 60 * 60_000) {
    return `Started ${Math.floor(ageMs / (60 * 60_000))}h ago`;
  }
  return `Started ${started.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

const shortRoutineSchedule = (schedule: string): string => schedule.replace(/ · next .+$/, '');

/**
 * Glanceable "now doing X" under a column header: sandbox boot phase while
 * launching, then the live run state (tool line / waiting-for-approval)
 * published by the embedded chat. Renders nothing when the column is idle.
 */
const ColumnStatusLine = memo(({ tabId }: { tabId: CodeTabId }) => {
  const activity = useStore($columnActivity, { keys: [tabId] })[tabId];
  const bootPhase = useStore($codeTabPhases, { keys: [tabId] })[tabId];
  const bootText = bootPhase ? BOOT_PHASE_LABELS[bootPhase] : undefined;
  const text = bootText ?? activityStatusText(activity);
  if (!text) {
    return null;
  }
  const waiting = !bootText && !!activity?.pendingApproval;
  return (
    // Deliberately NOT a live region: with many columns, per-column
    // role="status" produced interleaved narration. The StatusAnnouncer at
    // the App root is the one screen-reader voice for column transitions.
    <div className="flex items-center gap-1.5 min-w-0 pl-4 pr-4 pt-px pb-1">
      <span
        className={cn(
          'size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none',
          waiting && 'bg-warning animate-none'
        )}
        aria-hidden="true"
      />
      {/* Keyed by text: each phase/tool transition ticks in with a small
             fade+rise instead of snapping — the session-birth sequence reads as
             one line morphing through its states. (MotionConfig disables this
             under reduced motion.) */}
      <motion.span
        key={text}
        initial={{ opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: FADE_DURATION_S }}
        className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
        title={text}
      >
        {text}
      </motion.span>
    </div>
  );
});
ColumnStatusLine.displayName = 'ColumnStatusLine';

/**
 * One dot per column in the phone pager — the deck map. Each dot carries its
 * column's live state (the aura, distilled to 8px): brand + pulse while the
 * agent boots/works, amber while an approval waits, neutral when idle. The
 * current page is the elongated pill. Subscribes per-key like ColumnAura so
 * the strip doesn't re-render the deck.
 */
const DeckMapDot = memo(
  ({
    tab,
    label,
    isActive,
    onSelect,
  }: {
    tab: CodeTab;
    label: string;
    isActive: boolean;
    onSelect: (id: CodeTabId) => void;
  }) => {
    const activity = useStore($columnActivity, { keys: [tab.id] })[tab.id];
    const bootPhase = useStore($codeTabPhases, { keys: [tab.id] })[tab.id];
    const waiting = !!activity?.pendingApproval;
    const live = !waiting && (!!activity?.thinking || !!(bootPhase && BOOT_PHASE_LABELS[bootPhase]));
    const handleClick = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="flex items-center justify-center pt-2 pb-2 pl-2 pr-2 border-0 bg-transparent cursor-pointer focus-visible:outline-2 outline-ring focus-visible:-outline-offset-2 focus-visible:rounded-lg"
        onClick={handleClick}
        aria-label={waiting ? `Go to ${label} (waiting for approval)` : `Go to ${label}`}
        aria-current={isActive ? 'true' : undefined}
      >
        <span
          className={cn(
            'w-2 h-2 rounded bg-muted-foreground opacity-45 transition-all duration-200 ease-in-out motion-reduce:transition-colors',
            isActive && 'w-4.5 opacity-100',
            live && 'animate-pulse bg-primary opacity-90 motion-reduce:animate-none',
            waiting && 'bg-warning opacity-100 animate-none'
          )}
        />
      </Button>
    );
  }
);
DeckMapDot.displayName = 'DeckMapDot';

const DeckMap = memo(
  ({
    tabs,
    currentTabId,
    resolveLabel,
    onSelect,
  }: {
    tabs: CodeTab[];
    currentTabId: CodeTabId | null;
    resolveLabel: (tab: CodeTab) => string;
    onSelect: (id: CodeTabId) => void;
  }) => {
    if (tabs.length < 2) {
      return null;
    }
    return (
      <div
        className="hidden [@media(max-width:540px)]:flex [@media(max-width:540px)]:items-center [@media(max-width:540px)]:justify-center [@media(max-width:540px)]:shrink-0 [@media(max-width:540px)]:pt-0.5 [@media(max-width:540px)]:pb-1"
        role="group"
        aria-label="Columns"
      >
        {tabs.map((tab) => (
          <DeckMapDot
            key={tab.id}
            tab={tab}
            label={resolveLabel(tab)}
            isActive={tab.id === currentTabId}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }
);
DeckMap.displayName = 'DeckMap';

const CodeSessionHeader = memo(
  ({
    label,
    subLabel,
    statusTabId,
    ticketTitle,
    routineName,
    routineSchedule,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onArchive,
    dragHandle,
    dragSurfaceProps,
    ticketId,
    projectId,
    onOpenPanel,
  }: {
    label: string;
    /** Identity context when there is no ticket banner (e.g. "Started 2h ago"). */ subLabel?: string | null;
    /** When set, a live ColumnStatusLine for this tab renders under the header. */ statusTabId?: CodeTabId;
    ticketTitle?: string | null;
    routineName?: string | null;
    routineSchedule?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onArchive?: () => void;
    dragHandle?: React.ReactNode;
    dragSurfaceProps?: React.HTMLAttributes<HTMLDivElement>;
    ticketId?: TicketId;
    projectId?: ProjectId | null;
    onOpenPanel?: (panel: TicketPanel) => void;
  }) => {
    // Artifacts is a developer surface: it only exists for ticket runs on
    // repo-source projects. Plain-folder projects have one output concept —
    // the folder itself — so the menu item never appears for them.
    const store = useStore(persistedStoreApi.$atom);
    const showArtifacts = Boolean(ticketId) && projectHasRepoSource(store.projects.find((p) => p.id === projectId));
    return (
      <>
        <div
          className={cn(
            'relative flex items-center justify-between pl-4 pr-2 pt-1 pb-1 min-h-8 bg-transparent',
            'cursor-grab select-none select-none touch-manipulation active:cursor-grabbing'
          )}
          {...dragSurfaceProps}
        >
          <div className={cn('flex items-center', 'gap-2', 'min-w-0')}>
            {dragHandle}
            <span
              className="text-xs font-medium text-muted-foreground tracking-normal overflow-hidden text-ellipsis whitespace-nowrap"
              title={label}
            >
              {label}
            </span>
            {subLabel && (
              <span
                className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap shrink min-w-0"
                title={subLabel}
              >
                {subLabel}
              </span>
            )}
          </div>
          <div className={cn('flex items-center', 'gap-1')}>
            {actions}
            {onArchive && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Session menu" title="Session menu">
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <>
                  <DropdownMenuContent>
                    {onOpenPanel && (
                      <>
                        <DropdownMenuItem onClick={() => onOpenPanel('overview')}>Overview</DropdownMenuItem>
                        {showArtifacts && (
                          <DropdownMenuItem onClick={() => onOpenPanel('artifacts')}>Results</DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem onClick={onArchive}>
                      <Archive />
                      Archive session
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </>
              </DropdownMenu>
            )}
          </div>
        </div>
        {ticketTitle && (
          <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 pr-4 pt-0.5 pb-1 bg-transparent')}>
            <span
              className="basis-full grow min-w-0 text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap sm:flex-1"
              title={ticketTitle}
            >
              {ticketTitle}
            </span>
            {(ticketColumnBadge || ticketMetaBadge) && (
              <span className="flex items-center gap-2 shrink-0">
                {ticketColumnBadge}
                {ticketMetaBadge}
              </span>
            )}
            {ticketActions && <div className="flex items-center gap-1.5 shrink-0 ml-auto">{ticketActions}</div>}
          </div>
        )}
        {!ticketTitle && routineName && (
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 pr-4 pt-0.5 pb-1 bg-muted border-t border-border border-b border-border'
            )}
          >
            <span className="items-center bg-secondary border border-border rounded-full text-secondary-foreground inline-flex shrink-0 text-xs font-semibold gap-1 px-2 py-px">
              <RefreshCw className="size-3" />
              Routine
            </span>
            <span
              className="text-muted-foreground min-w-40 flex-1 text-xs min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              title={routineName}
            >
              {routineName}
            </span>
            {routineSchedule && (
              <span
                className="text-muted-foreground shrink-0 text-xs overflow-hidden text-ellipsis whitespace-nowrap"
                title={routineSchedule}
              >
                {shortRoutineSchedule(routineSchedule)}
              </span>
            )}
          </div>
        )}
        {statusTabId && <ColumnStatusLine tabId={statusTabId} />}
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
    routineName,
    routineSchedule,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onArchive,
    onFocus,
    isExpanded,
    onToggleExpand,
    children,
    headerActionsSlot,
    hasSidecar,
  }: {
    tab: CodeTab;
    label: string;
    ticketTitle?: string | null;
    routineName?: string | null;
    routineSchedule?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onArchive: (id: CodeTabId) => void;
    onFocus: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
    children: React.ReactNode;
    headerActionsSlot?: React.ReactNode;
    hasSidecar?: boolean;
  }) => {
    // dnd-kit moves only the actively dragged column (transition: null) — the
    // displaced columns settle via the card's framer layout animation below,
    // so there's exactly one animator per element.
    const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
      id: tab.id,
      transition: null,
    });
    const style = {
      transform: CSS.Transform.toString(transform),
    };
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);
    useNowMinute();

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden bg-transparent',
          isDragging && 'opacity-85'
        )}
      >
        <motion.div
          layoutId={`colcard-${tab.id}`}
          layout
          transition={SPRING_STANDARD}
          initial={ENTER_INITIAL}
          animate={ENTER_ANIMATE}
          className={cn(
            'flex flex-1 flex-col min-w-0 min-h-0 relative border border-border rounded-2xl overflow-hidden m-2 bg-card transition-colors duration-100 ease-in-out [&:hover_.revealOnHover]:opacity-100 [&:focus-within_.revealOnHover]:opacity-100 hover:border-primary',
            hasSidecar && 'mr-0 rounded-tr-none rounded-br-none',
            isDragging && 'shadow-xl'
          )}
        >
          <ColumnAura tabId={tab.id} />
          <CodeSessionHeader
            label={label}
            subLabel={ticketTitle || routineName ? null : startedLabel(tab)}
            statusTabId={tab.id}
            ticketTitle={ticketTitle}
            routineName={routineName}
            routineSchedule={routineSchedule}
            ticketColumnBadge={ticketColumnBadge}
            ticketMetaBadge={ticketMetaBadge}
            ticketActions={ticketActions}
            actions={
              <div className={cn('flex items-center', 'gap-1')}>
                {headerActionsSlot}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Focus ${label}`}
                  title="Focus session"
                  onClick={() => onFocus(tab.id)}
                >
                  <Scan className="size-4" />
                </Button>
                <Toggle
                  size="sm"
                  pressed={isExpanded}
                  aria-label={isExpanded ? 'Collapse column' : 'Expand column'}
                  title={isExpanded ? 'Collapse column' : 'Expand column'}
                  onPressedChange={() => onToggleExpand(tab.id)}
                >
                  {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </Toggle>
                {actions}
              </div>
            }
            onArchive={() => onArchive(tab.id)}
            ticketId={tab.ticketId as TicketId | undefined}
            projectId={tab.projectId}
            onOpenPanel={tab.ticketId ? setActivePanel : undefined}
            dragSurfaceProps={listeners}
            dragHandle={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="sr-only cursor-grab text-muted-foreground focus-visible:not-sr-only focus-visible:relative focus-visible:size-5 focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1"
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${label}`}
              >
                <GripVertical className="size-4" />
              </Button>
            }
          />

          <PullRequestBanner scope={{ kind: 'code-tab', tabId: tab.id }} />
          <div className="flex-1 min-h-0 relative">
            {children}
            {tab.ticketId && (
              <TicketPanelOverlay panel={activePanel} ticketId={tab.ticketId as TicketId} onClose={handleClosePanel} />
            )}
          </div>
        </motion.div>
        <div
          id={`code-deck-dock-target-${tab.id}`}
          className="deckDockSlot w-full min-w-0 min-h-0 overflow-hidden shrink-0"
        />
      </div>
    );
  }
);
DeckColumn.displayName = 'DeckColumn';

const AppColumn = memo(
  ({
    tab,
    app,
    onClose,
    onFocus,
    isExpanded,
    onToggleExpand,
  }: {
    tab: CodeTab;
    app: CustomAppEntry;
    onClose: (id: CodeTabId) => void;
    onFocus: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };
    const registryProps = useMemo(() => {
      const scope: AppHandleScope = app.columnScoped ? 'column' : 'global';
      return {
        handleId: makeAppHandleId(scope, app.id, scope === 'column' ? tab.id : undefined),
        appId: app.id,
        kind: 'webview' as const,
        scope,
        ...(scope === 'column' ? { tabId: tab.id } : {}),
        label: app.label,
      };
    }, [app.id, app.label, app.columnScoped, tab.id]);

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden bg-transparent',
          isDragging && 'opacity-85'
        )}
      >
        <div
          className={cn(
            'flex flex-1 flex-col min-w-0 min-h-0 relative border border-border rounded-2xl overflow-hidden m-2 bg-card transition-colors duration-100 ease-in-out [&:hover_.revealOnHover]:opacity-100 [&:focus-within_.revealOnHover]:opacity-100 hover:border-primary'
          )}
        >
          <div
            className={cn(
              'relative flex items-center justify-between pl-4 pr-2 pt-1 pb-1 min-h-8 bg-transparent',
              'cursor-grab select-none select-none touch-manipulation active:cursor-grabbing'
            )}
            {...listeners}
          >
            <div className={cn('flex items-center', 'gap-2', 'min-w-0')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="sr-only cursor-grab text-muted-foreground focus-visible:not-sr-only focus-visible:relative focus-visible:size-5 focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1"
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${app.label}`}
              >
                <GripVertical className="size-4" />
              </Button>
              <span
                className="text-xs font-medium text-muted-foreground tracking-normal overflow-hidden text-ellipsis whitespace-nowrap"
                title={app.label}
              >
                {app.label}
              </span>
            </div>
            <div className={cn('flex items-center', 'gap-1')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Focus ${app.label}`}
                title="Focus app"
                onClick={() => onFocus(tab.id)}
              >
                <Scan className="size-4" />
              </Button>
              <Toggle
                size="sm"
                pressed={isExpanded}
                aria-label={isExpanded ? 'Collapse column' : 'Expand column'}
                title={isExpanded ? 'Collapse column' : 'Expand column'}
                onPressedChange={() => onToggleExpand(tab.id)}
              >
                {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Toggle>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Close ${app.label}`}
                title={`Close ${app.label}`}
                onClick={() => onClose(tab.id)}
              >
                <Plus className="size-4 rotate-45" />
              </Button>
            </div>
          </div>
          <div className="flex-1 min-h-0 relative">
            <Webview
              src={app.url}
              partition={customAppPartition(app.id)}
              showUnavailable={false}
              registry={registryProps}
            />
          </div>
        </div>
        <div className="deckDockSlot w-full min-w-0 min-h-0 overflow-hidden shrink-0" />
      </div>
    );
  }
);
AppColumn.displayName = 'AppColumn';

/**
 * Standalone browser deck column. Chrome (drag handle, expand/collapse, close)
 * lives here; the browser itself is the shared `BrowserView` component so the
 * standalone column and the per-session dock stay behaviorally identical.
 */
const BrowserColumn = memo(
  ({
    tab,
    onClose,
    onFocus,
    isExpanded,
    onToggleExpand,
  }: {
    tab: CodeTab;
    onClose: (id: CodeTabId) => void;
    onFocus: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden bg-transparent',
          isDragging && 'opacity-85'
        )}
      >
        <div
          className={cn(
            'flex flex-1 flex-col min-w-0 min-h-0 relative border border-border rounded-2xl overflow-hidden m-2 bg-card transition-colors duration-100 ease-in-out [&:hover_.revealOnHover]:opacity-100 [&:focus-within_.revealOnHover]:opacity-100 hover:border-primary'
          )}
        >
          <div
            className={cn(
              'relative flex items-center justify-between pl-4 pr-2 pt-1 pb-1 min-h-8 bg-transparent',
              'cursor-grab select-none select-none touch-manipulation active:cursor-grabbing'
            )}
            {...listeners}
          >
            <div className={cn('flex items-center', 'gap-2', 'min-w-0')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="sr-only cursor-grab text-muted-foreground focus-visible:not-sr-only focus-visible:relative focus-visible:size-5 focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1"
                {...attributes}
                {...listeners}
                aria-label="Reorder Browser"
              >
                <GripVertical className="size-4" />
              </Button>
              <Globe className="size-3.5 text-foreground/80" />
              <span
                className="text-xs font-medium text-muted-foreground tracking-normal overflow-hidden text-ellipsis whitespace-nowrap"
                title="Browser"
              >
                Browser
              </span>
            </div>
            <div className={cn('flex items-center', 'gap-1')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Focus Browser"
                title="Focus app"
                onClick={() => onFocus(tab.id)}
              >
                <Scan className="size-4" />
              </Button>
              <Toggle
                size="sm"
                pressed={isExpanded}
                aria-label={isExpanded ? 'Collapse column' : 'Expand column'}
                title={isExpanded ? 'Collapse column' : 'Expand column'}
                onPressedChange={() => onToggleExpand(tab.id)}
              >
                {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Toggle>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close Browser"
                title="Close Browser"
                onClick={() => onClose(tab.id)}
              >
                <Plus className="size-4 rotate-45" />
              </Button>
            </div>
          </div>
          <div className="flex-1 min-h-0 relative">
            <BrowserView tabsetId={`col:${tab.id}`} />
          </div>
        </div>
        <div className="deckDockSlot w-full min-w-0 min-h-0 overflow-hidden shrink-0" />
      </div>
    );
  }
);
BrowserColumn.displayName = 'BrowserColumn';

type SidecarBodyProps = {
  app: AppDescriptor;
  originTabId: CodeTabId;
  filesHost: HTMLDivElement;
  gitHost: HTMLDivElement;
  sandboxUrls: { environmentId?: string; services?: Record<string, string> } | undefined;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
};

/**
 * One persistent sidecar app body. CodeDeck portals it into a stable detached
 * host, and the active layout adopts that host. This preserves terminal
 * scrollback, browser navigation, and editor state across tab and layout
 * switches.
 */
const SidecarBody = memo(
  ({ app, originTabId, filesHost, gitHost, sandboxUrls, previewUrl, onPreviewUrlChange }: SidecarBodyProps) => {
    const registryProps = useMemo(
      () => ({
        handleId: makeAppHandleId('column', app.id, originTabId),
        appId: app.id,
        kind: app.kind,
        scope: 'column' as AppHandleScope,
        tabId: originTabId,
        label: app.label,
      }),
      [app.id, app.label, app.kind, originTabId]
    );

    let body: React.ReactNode = null;
    if (app.kind === 'builtin-browser') {
      body = (
        <BrowserView
          tabsetId={`dock:${originTabId}`}
          registryScope="column"
          registryTabId={originTabId}
          src={previewUrl}
          onUrlChange={onPreviewUrlChange}
        />
      );
    } else if (app.kind === 'builtin-terminal') {
      body = sandboxUrls ? (
        <ConsoleStarted tabId={originTabId} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Terminal is available after the session starts.
        </div>
      );
    } else if (app.kind === 'builtin-files') {
      body = sandboxUrls?.environmentId ? (
        <TabContentSlot host={filesHost} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Files are available after the session starts.
        </div>
      );
    } else if (app.kind === 'builtin-git') {
      body = sandboxUrls?.environmentId ? (
        <TabContentSlot host={gitHost} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Git is available after the session starts.
        </div>
      );
    } else if (app.kind === 'builtin-code') {
      body = sandboxUrls?.services?.['code_server'] ? (
        <Webview src={sandboxUrls.services['code_server']} showUnavailable={false} registry={registryProps} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          {app.label} is unavailable for this workspace.
        </div>
      );
    } else if (app.kind === 'builtin-desktop') {
      body = sandboxUrls?.services?.['vnc'] ? (
        <Webview src={sandboxUrls.services['vnc']} showUnavailable={false} registry={registryProps} />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          {app.label} is unavailable for this workspace.
        </div>
      );
    } else if (app.kind === 'webview') {
      body = app.url ? (
        <Webview
          src={app.url}
          partition={customAppPartition(app.id)}
          showUnavailable={false}
          registry={registryProps}
        />
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No URL configured.</div>
      );
    }

    return <div className="absolute inset-0">{body}</div>;
  }
);
SidecarBody.displayName = 'SidecarBody';

/**
 * Non-sortable adjacent column hosting the open app tabs bound to an origin
 * session. Every open app remains mounted while inactive so its browser,
 * terminal, editor, or webview state survives tab switches.
 */
const SidecarColumn = memo(
  ({
    apps,
    activeAppId,
    availableApps,
    getAppHost,
    onActivate,
    onCloseApp,
    onOpenApp,
    isExpanded,
    onToggleExpand,
    canExpand = true,
    presentation = 'tile',
  }: {
    apps: AppDescriptor[];
    activeAppId?: AppId;
    availableApps: AppDescriptor[];
    getAppHost: (appId: AppId) => HTMLDivElement;
    onActivate: (appId: AppId) => void;
    onCloseApp: (appId: AppId) => void;
    onOpenApp: (appId: AppId) => void;
    isExpanded: boolean;
    onToggleExpand: () => void;
    canExpand?: boolean;
    presentation?: 'tile' | 'focus';
  }) => {
    const addableApps = availableApps.filter((app) => !apps.some((openApp) => openApp.id === app.id));

    return (
      <div className="flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden bg-transparent">
        <div
          className={cn(
            presentation === 'focus'
              ? 'flex flex-1 flex-col min-w-0 min-h-0 relative overflow-hidden bg-card'
              : 'flex flex-1 flex-col min-w-0 min-h-0 relative border border-border rounded-2xl overflow-hidden m-2 bg-card transition-colors duration-100 ease-in-out [&:hover_.revealOnHover]:opacity-100 [&:focus-within_.revealOnHover]:opacity-100 hover:border-primary',
            presentation === 'tile' && 'ml-0 rounded-tl-none rounded-bl-none border-l-2'
          )}
        >
          <Tabs value={activeAppId ?? ''} onValueChange={onActivate} className="h-full min-h-0 gap-0">
            <div className="flex items-center gap-1 min-h-10 pl-2 pr-2 border-b border-border shrink-0">
              {apps.length > 0 ? (
                <TabsList
                  variant="line"
                  className="h-9 min-w-0 flex-1 justify-start overflow-x-auto overflow-y-hidden p-0 gap-0 scrollbar-none [&::-webkit-scrollbar]:hidden"
                  aria-label="Open column apps"
                >
                  {apps.map((app) => (
                    <div key={app.id} className="group/sidecar-tab relative flex min-w-0 shrink-0">
                      <TabsTrigger
                        value={app.id}
                        className="h-9 max-w-45 min-w-22 justify-start pl-2 pr-8 text-xs font-medium"
                        title={app.label}
                      >
                        <AppIcon icon={app.icon} size={16} />
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{app.label}</span>
                      </TabsTrigger>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/sidecar-tab:opacity-100 focus-visible:opacity-100 transition-colors duration-100"
                        aria-label={`Close ${app.label}`}
                        title={`Close ${app.label}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseApp(app.id);
                        }}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  ))}
                </TabsList>
              ) : (
                <div className="flex min-w-0 flex-1 items-center px-2 text-xs font-medium text-muted-foreground">
                  Apps
                </div>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 shrink-0"
                    aria-label="Open app tab"
                    title="Open app tab"
                  >
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {addableApps.length > 0 ? (
                    addableApps.map((app) => (
                      <DropdownMenuItem key={app.id} onClick={() => onOpenApp(app.id)}>
                        <AppIcon icon={app.icon} size={16} />
                        {app.label}
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem disabled>No other apps available</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {canExpand && (
                <Toggle
                  size="sm"
                  pressed={isExpanded}
                  aria-label={isExpanded ? 'Collapse column' : 'Expand column'}
                  title={isExpanded ? 'Collapse column' : 'Expand column'}
                  onPressedChange={onToggleExpand}
                >
                  {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </Toggle>
              )}
            </div>
            <div className="flex-1 min-h-0 relative">
              {apps.length === 0 ? (
                <Empty className="absolute inset-0 rounded-none border-0">
                  <EmptyHeader>
                    <EmptyTitle className="text-base">Open an app</EmptyTitle>
                    <EmptyDescription>Choose an app for this session’s sidecar.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="grid max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                    {availableApps.map((app) => (
                      <Button
                        key={app.id}
                        type="button"
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => onOpenApp(app.id)}
                      >
                        <AppIcon icon={app.icon} size={16} />
                        {app.label}
                      </Button>
                    ))}
                  </EmptyContent>
                </Empty>
              ) : (
                apps.map((app) => (
                  <div key={app.id} className={cn('absolute inset-0', app.id !== activeAppId && 'hidden')}>
                    <TabContentSlot host={getAppHost(app.id)} />
                  </div>
                ))
              )}
            </div>
          </Tabs>
        </div>
        <div className="deckDockSlot w-full min-w-0 min-h-0 overflow-hidden shrink-0" />
      </div>
    );
  }
);
SidecarColumn.displayName = 'SidecarColumn';

const LAUNCHER_CELL_MIN_PX = 64;
const LAUNCHER_CELL_MAX_PX = 96;
const LAUNCHER_COL_GAP_PX = 20;
const LAUNCHER_HEX_MAX_HEIGHT = 15;

type LauncherLayout = { rows: number[]; cellWidth: number; uniform: boolean };

/**
 * Picks the smallest symmetric hex-diamond shape whose capacity ≥ n, then
 * sizes cells to fit the container. A shape of height h (odd) and peak width
 * k has rows [k-m, …, k-1, k, k-1, …, k-m] where m=(h-1)/2, capacity =
 * k*h − m*(m+1). If the ideal shape's peak can't fit even at min cell width,
 * falls back to a taller/narrower shape; ultimately to uniform rows with
 * manual honeycomb offset.
 */
function computeLauncherLayout(n: number, containerWidth: number): LauncherLayout {
  if (n <= 0) {
    return { rows: [], cellWidth: LAUNCHER_CELL_MIN_PX, uniform: false };
  }

  type Candidate = { h: number; k: number; capacity: number; cellWidth: number };
  const candidates: Candidate[] = [];

  for (let h = 1; h <= LAUNCHER_HEX_MAX_HEIGHT; h += 2) {
    const m = (h - 1) / 2;
    const minK = m + 1;
    const k = Math.max(minK, Math.ceil((n + m * (m + 1)) / h));
    const capacity = k * h - m * (m + 1);
    if (capacity < n) {
      continue;
    }
    const cellWidth = (containerWidth - LAUNCHER_COL_GAP_PX * (k - 1)) / k;
    if (cellWidth < LAUNCHER_CELL_MIN_PX) {
      continue;
    }
    candidates.push({ h, k, capacity, cellWidth });
  }

  if (candidates.length > 0) {
    // Prefer smallest capacity (fewest empty slots), tiebreak by fewest rows.
    candidates.sort((a, b) => a.capacity - b.capacity || a.h - b.h);
    const { h, k, cellWidth } = candidates[0]!;
    const m = (h - 1) / 2;
    const rows: number[] = [];
    for (let i = 0; i < h; i++) {
      rows.push(k - Math.abs(i - m));
    }
    const uniform = rows.length === 1 || rows.every((w) => w === rows[0]);
    return {
      rows,
      cellWidth: Math.min(LAUNCHER_CELL_MAX_PX, cellWidth),
      uniform,
    };
  }

  // Fallback: uniform rows at min cell width
  const maxCols = Math.max(
    2,
    Math.floor((containerWidth + LAUNCHER_COL_GAP_PX) / (LAUNCHER_CELL_MIN_PX + LAUNCHER_COL_GAP_PX))
  );
  const rows: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    const w = Math.min(remaining, maxCols);
    rows.push(w);
    remaining -= w;
  }
  return { rows, cellWidth: LAUNCHER_CELL_MIN_PX, uniform: true };
}

const AppLauncherGrid = memo(({ apps, onPick }: { apps: CustomAppEntry[]; onPick: (appId: string) => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(480);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { rows, cellWidth, uniform } = useMemo(() => {
    const layout = computeLauncherLayout(apps.length, containerWidth);
    const chunked: CustomAppEntry[][] = [];
    let idx = 0;
    for (const count of layout.rows) {
      chunked.push(apps.slice(idx, idx + count));
      idx += count;
    }
    return { rows: chunked, cellWidth: layout.cellWidth, uniform: layout.uniform };
  }, [apps, containerWidth]);

  return (
    <div
      ref={ref}
      className="omni-code-deck-launcher-grid"
      style={{ ['--launcher-cell-width' as string]: `${cellWidth}px` }}
    >
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className={cn('flex justify-center gap-5', uniform && rowIndex % 2 === 1 && 'omni-code-deck-launcher-offset')}
        >
          {row.map((app) => (
            <Button
              key={app.id}
              type="button"
              variant="ghost"
              className={cn(
                'omni-code-deck-launcher-cell flex h-auto shrink-0 scale-105 cursor-pointer flex-col items-center gap-2 whitespace-normal border-0 bg-transparent p-0 transition-transform duration-200 ease-in-out hover:-translate-y-0.5 active:translate-y-0 active:scale-95 motion-reduce:hover:transform-none motion-reduce:active:transform-none'
              )}
              onClick={() => onPick(app.id)}
              title={app.label}
            >
              <span
                className={cn(
                  'omni-code-deck-launcher-icon flex size-16 shrink-0 items-center justify-center rounded-full text-foreground'
                )}
              >
                <AppIcon icon={app.icon} size={32} />
              </span>
              <span className="text-xs font-medium text-foreground text-center overflow-hidden text-ellipsis whitespace-nowrap max-w-full">
                {app.label}
              </span>
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
});
AppLauncherGrid.displayName = 'AppLauncherGrid';

const AppLauncherColumn = memo(
  ({
    tab,
    customApps,
    onClose,
    onFocus,
    isExpanded,
    onToggleExpand,
  }: {
    tab: CodeTab;
    customApps: CustomAppEntry[];
    onClose: (id: CodeTabId) => void;
    onFocus: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };

    const handlePick = useCallback(
      (appId: string) => {
        void codeApi.setTabAppId(tab.id, appId);
      },
      [tab.id]
    );

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden bg-transparent',
          isDragging && 'opacity-85'
        )}
      >
        <div
          className={cn(
            'flex flex-1 flex-col min-w-0 min-h-0 relative border border-border rounded-2xl overflow-hidden m-2 bg-card transition-colors duration-100 ease-in-out [&:hover_.revealOnHover]:opacity-100 [&:focus-within_.revealOnHover]:opacity-100 hover:border-primary'
          )}
        >
          <div
            className={cn(
              'relative flex items-center justify-between pl-4 pr-2 pt-1 pb-1 min-h-8 bg-transparent',
              'cursor-grab select-none select-none touch-manipulation active:cursor-grabbing'
            )}
            {...listeners}
          >
            <div className={cn('flex items-center', 'gap-2', 'min-w-0')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="sr-only cursor-grab text-muted-foreground focus-visible:not-sr-only focus-visible:relative focus-visible:size-5 focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1"
                {...attributes}
                {...listeners}
                aria-label="Reorder Apps"
              >
                <GripVertical className="size-4" />
              </Button>
              <span
                className="text-xs font-medium text-muted-foreground tracking-normal overflow-hidden text-ellipsis whitespace-nowrap"
                title="Apps"
              >
                Apps
              </span>
            </div>
            <div className={cn('flex items-center', 'gap-1')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Focus Apps"
                title="Focus apps"
                onClick={() => onFocus(tab.id)}
              >
                <Scan className="size-4" />
              </Button>
              <Toggle
                size="sm"
                pressed={isExpanded}
                aria-label={isExpanded ? 'Collapse column' : 'Expand column'}
                title={isExpanded ? 'Collapse column' : 'Expand column'}
                onPressedChange={() => onToggleExpand(tab.id)}
              >
                {isExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Toggle>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close Apps"
                title="Close Apps"
                onClick={() => onClose(tab.id)}
              >
                <Plus className="size-4 rotate-45" />
              </Button>
            </div>
          </div>
          <div
            className={cn(
              'flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center pt-12 pl-8 pr-8 pb-12 bg-card'
            )}
          >
            {customApps.length === 0 ? (
              <div className="text-muted-foreground text-xs text-center pt-8">
                No apps installed. Add apps in Settings.
              </div>
            ) : (
              <AppLauncherGrid apps={customApps} onPick={handlePick} />
            )}
          </div>
        </div>
        <div className="deckDockSlot w-full min-w-0 min-h-0 overflow-hidden shrink-0" />
      </div>
    );
  }
);
AppLauncherColumn.displayName = 'AppLauncherColumn';

const CodeSessionPane = memo(
  ({
    tab,
    label,
    ticketTitle,
    routineName,
    routineSchedule,
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onArchive,
    isVisible,
    content,
  }: {
    tab: CodeTab;
    label: string;
    ticketTitle?: string | null;
    routineName?: string | null;
    routineSchedule?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onArchive: (id: CodeTabId) => void;
    isVisible: boolean;
    /** The tab's content slot — CodeDeck portals the persistent CodeTabContent here. */ content: React.ReactNode;
  }) => {
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);
    useNowMinute();

    return (
      // Shared-element target for Focus-as-zoom: only the visible pane claims
      // the card's layoutId (hidden panes are display:none and would report
      // zero bounds). Switching Tile <-> Focus morphs the active column
      // between its tile card and this full pane.
      <motion.div
        layoutId={isVisible ? `colcard-${tab.id}` : undefined}
        layout={isVisible}
        transition={SPRING_GENTLE}
        className={cn('w-full h-full flex flex-col relative bg-card', !isVisible && 'hidden')}
      >
        <ColumnAura tabId={tab.id} />
        <CodeSessionHeader
          label={label}
          subLabel={ticketTitle || routineName ? null : startedLabel(tab)}
          statusTabId={tab.id}
          ticketTitle={ticketTitle}
          routineName={routineName}
          routineSchedule={routineSchedule}
          ticketColumnBadge={ticketColumnBadge}
          ticketMetaBadge={ticketMetaBadge}
          ticketActions={ticketActions}
          actions={actions}
          onArchive={() => onArchive(tab.id)}
          ticketId={tab.ticketId as TicketId | undefined}
          projectId={tab.projectId}
          onOpenPanel={tab.ticketId ? setActivePanel : undefined}
        />

        <PullRequestBanner scope={{ kind: 'code-tab', tabId: tab.id }} />
        <div className="flex-1 min-h-0 relative">
          {content}
          {tab.ticketId && (
            <TicketPanelOverlay panel={activePanel} ticketId={tab.ticketId as TicketId} onClose={handleClosePanel} />
          )}
        </div>
      </motion.div>
    );
  }
);
CodeSessionPane.displayName = 'CodeSessionPane';

/**
 * Layout-transparent adopter for a column's persistent content. CodeDeck
 * portals each session tab's SINGLE long-lived CodeTabContent into a STABLE
 * detached <div> (the host); Tile and Focus each render one TabContentSlot
 * that imperatively appends that host into its own DOM. Switching layout
 * modes therefore MOVES the rendered session instead of remounting it — no
 * agent reconnect, no transcript reload, composer drafts survive. The portal
 * container must stay identity-stable: React reconciles createPortal by
 * container, so portaling into per-mode slot elements would remount.
 */
const TabContentSlot = memo(({ host }: { host: HTMLDivElement }) => {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        el.appendChild(host);
      }
    },
    [host]
  );
  return <div ref={ref} className="contents" />;
});
TabContentSlot.displayName = 'TabContentSlot';

export const CodeDeck = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const statuses = useStore($codeTabStatuses);
  const tabs = useMemo(() => store.codeTabs ?? [], [store.codeTabs]);
  // One persistent CodeTabContent per session tab, portaled into a stable
  // detached host that the live layout mode's TabContentSlot adopts.
  const sessionTabs = useMemo(() => tabs.filter((t) => !t.customAppId), [tabs]);
  const contentHostsRef = useRef<Map<CodeTabId, HTMLDivElement>>(new Map());
  const filesHostsRef = useRef<Map<CodeTabId, HTMLDivElement>>(new Map());
  const gitHostsRef = useRef<Map<CodeTabId, HTMLDivElement>>(new Map());
  const sidecarHostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const getContentHost = useCallback((tabId: CodeTabId): HTMLDivElement => {
    let host = contentHostsRef.current.get(tabId);
    if (!host) {
      host = document.createElement('div');
      host.style.display = 'contents';
      contentHostsRef.current.set(tabId, host);
    }
    return host;
  }, []);
  const getFilesHost = useCallback((tabId: CodeTabId): HTMLDivElement => {
    let host = filesHostsRef.current.get(tabId);
    if (!host) {
      host = document.createElement('div');
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.minHeight = '0';
      filesHostsRef.current.set(tabId, host);
    }
    return host;
  }, []);
  const getGitHost = useCallback((tabId: CodeTabId): HTMLDivElement => {
    let host = gitHostsRef.current.get(tabId);
    if (!host) {
      host = document.createElement('div');
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.minHeight = '0';
      gitHostsRef.current.set(tabId, host);
    }
    return host;
  }, []);
  const getSidecarHost = useCallback((tabId: CodeTabId, appId: AppId): HTMLDivElement => {
    const key = `${tabId}:${appId}`;
    let host = sidecarHostsRef.current.get(key);
    if (!host) {
      host = document.createElement('div');
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.minHeight = '0';
      host.style.position = 'relative';
      sidecarHostsRef.current.set(key, host);
    }
    return host;
  }, []);
  useEffect(() => {
    const live = new Set<string>(sessionTabs.map((t) => t.id));
    for (const id of [...contentHostsRef.current.keys()]) {
      if (!live.has(id)) {
        contentHostsRef.current.delete(id);
      }
    }
    for (const id of [...filesHostsRef.current.keys()]) {
      if (!live.has(id)) {
        filesHostsRef.current.delete(id);
      }
    }
    for (const id of [...gitHostsRef.current.keys()]) {
      if (!live.has(id)) {
        gitHostsRef.current.delete(id);
      }
    }
    for (const key of [...sidecarHostsRef.current.keys()]) {
      if (![...live].some((id) => key.startsWith(`${id}:`))) {
        sidecarHostsRef.current.delete(key);
      }
    }
  }, [sessionTabs]);
  const activeTabId = store.activeCodeTabId ?? tabs[0]?.id ?? null;
  const [previewUrls, setPreviewUrls] = useState<Record<CodeTabId, string>>({});
  const [expandedTabIds, setExpandedTabIds] = useState<ReadonlySet<CodeTabId>>(() => spacesExpandedFromTabs(tabs));
  // Pixel sizes reported by the shadcn resizable group. A custom width
  // replaces the expand preset and vice versa.
  const [columnWidths, setColumnWidths] = useState<Record<CodeTabId, number>>(() => spacesWidthsFromTabs(tabs));
  const isUserResizingTileRef = useRef(false);
  const pendingColumnWidthsRef = useRef<Record<CodeTabId, number>>({});
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // Phones used to be forced into the pager, because Focus needed its own
  // session-list sidebar and had nowhere to put it. The unified nav drawer is
  // that list now, so Focus works at phone width — one full-bleed
  // conversation, the shape the mobile landing wants — and the stored choice
  // applies at every size. The toggle ships on phones too, so a `tile` picked
  // on desktop (the store is shared) is never a trap.
  const layoutMode = store.codeLayoutMode;
  const [deckViewportWidth, setDeckViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    const stopResizing = () => {
      isUserResizingTileRef.current = false;
    };
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);
    window.addEventListener('blur', stopResizing);
    return () => {
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      window.removeEventListener('blur', stopResizing);
    };
  }, []);

  // Mouse wheel → horizontal scroll on the deck (columns are laid out on a
  // single row). Leaves trackpad horizontal gestures alone and ignores wheel
  // events that originated inside a column (chat scrollbacks, etc.).
  const deckScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = deckScrollRef.current;
    if (!el) {
      return;
    }
    const update = () => setDeckViewportWidth(el.clientWidth || window.innerWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layoutMode, tabs.length]);

  useEffect(() => {
    const el = deckScrollRef.current;
    if (!el) {
      return;
    }
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0 || e.deltaX !== 0) {
        return;
      }
      // Respect nested vertical scroll areas (chat, file panes): walk from the
      // target up to the deck and bail if any ancestor can still scroll in
      // the direction of this wheel event.
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        const cs = getComputedStyle(node);
        const scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
        if (scrollable && node.scrollHeight > node.clientHeight) {
          const canScrollDown = e.deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1;
          const canScrollUp = e.deltaY < 0 && node.scrollTop > 0;
          if (canScrollDown || canScrollUp) {
            return;
          }
        }
        node = node.parentElement;
      }
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [layoutMode, tabs.length]);

  // ── Deck map: which column the phone pager is resting on ──
  const isPager = layoutMode === 'tile' && viewportWidth <= SNAP_SCROLL_WIDTH;
  const [pagerTabId, setPagerTabId] = useState<CodeTabId | null>(null);
  useEffect(() => {
    if (!isPager) {
      return;
    }
    const el = deckScrollRef.current;
    if (!el) {
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      let best: CodeTabId | null = null;
      let bestDist = Infinity;
      for (const node of el.querySelectorAll<HTMLElement>('[data-deck-column]')) {
        const dist = Math.abs(node.offsetLeft - el.scrollLeft);
        if (dist < bestDist) {
          bestDist = dist;
          best = (node.dataset.deckColumn ?? null) as CodeTabId | null;
        }
      }
      setPagerTabId(best);
    };
    const onScroll = () => {
      if (!raf) {
        raf = requestAnimationFrame(update);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [isPager, tabs.length]);

  const scrollToColumn = useCallback((tabId: CodeTabId) => {
    const target = deckScrollRef.current?.querySelector<HTMLElement>(
      `[data-deck-column="${window.CSS.escape(tabId)}"]`
    );
    target?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      inline: 'start',
      block: 'nearest',
    });
  }, []);

  // The pager has no other way to express "this column is active": with the
  // deck as the mobile landing, a fresh chat (boot landing, "New chat", a
  // deep link) is minted off-screen and the deck looks like it ignored it.
  // Swiping doesn't change activeTabId, so this never fights the user.
  useEffect(() => {
    if (!isPager || !activeTabId) {
      return;
    }
    scrollToColumn(activeTabId);
  }, [isPager, activeTabId, scrollToColumn]);

  useEffect(() => {
    const firstTab = tabs[0];
    if (!activeTabId && firstTab) {
      codeApi.setActiveTab(firstTab.id);
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (isUserResizingTileRef.current) {
      return;
    }
    setColumnWidths(spacesWidthsFromTabs(tabs));
    setExpandedTabIds(spacesExpandedFromTabs(tabs));
  }, [tabs]);

  // React to agent-triggered preview requests. We subscribe via `listen` rather
  // than `useStore` so every atom update fires — a rapid burst of requests all
  // get applied instead of being coalesced to the last-rendered value.
  const activeTabIdRef = useRef(activeTabId);
  const firstTabIdRef = useRef(tabs[0]?.id);
  activeTabIdRef.current = activeTabId;
  firstTabIdRef.current = tabs[0]?.id;
  useEffect(() => {
    const seen = new Set<string>();
    const unsubscribe = $previewRequest.listen((req) => {
      if (!req || seen.has(req.id)) {
        return;
      }
      seen.add(req.id);
      const targetTabId = (req.tabId as CodeTabId | undefined) ?? activeTabIdRef.current ?? firstTabIdRef.current;
      if (!targetTabId) {
        return;
      }
      setPreviewUrls((prev) => ({ ...prev, [targetTabId]: req.url }));
      void codeApi.openSidecarApp(targetTabId, 'browser');
      clearPreviewRequest();
    });
    return unsubscribe;
  }, []);

  // `launch_app` client tool → open (not toggle) a dock app in a column so its
  // webview mounts and becomes drivable. Same fire-every-update listener pattern
  // as the preview bridge above.
  useEffect(() => {
    const seen = new Set<string>();
    const unsubscribe = $appLaunchRequest.listen((req) => {
      if (!req || seen.has(req.id)) {
        return;
      }
      seen.add(req.id);
      void codeApi.openSidecarApp(req.tabId as CodeTabId, req.appId);
      clearAppLaunchRequest();
    });
    return unsubscribe;
  }, []);

  // Mouse drags on small movement; touch drags on long-press so swiping a
  // column header still scrolls the deck instead of starting a reorder.
  // Keyboard picks up via Space/Enter on the column's reorder handle and
  // moves with the arrow keys.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const projectMap = useMemo(() => {
    const map = new Map<string, { label: string; workspaceDir: string | undefined }>();
    for (const p of store.projects) {
      const s = firstSource(p);
      map.set(p.id, { label: p.label, workspaceDir: s?.kind === 'local' ? s.workspaceDir : undefined });
    }
    return map;
  }, [store.projects]);

  const customApps = useMemo(() => [SYNTHETIC_BROWSER_APP, ...(store.customApps ?? [])], [store.customApps]);
  const appRegistry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);

  // Conversation titles come from the launcher index ∪ the live session
  // listing, so open columns are titled even when the conversation predates
  // the index (migrated or resumed-from-server sessions).
  // Recent conversations moved to the app sidebar's Sessions section; the
  // deck still needs the title union for open-column labels.
  const { sessionTitles } = useRecentConversations(tabs);

  const resolveLabel = useCallback(
    (tab: CodeTab) => {
      if (tab.customAppId === APP_LAUNCHER_ID) {
        return 'Apps';
      }
      if (tab.customAppId) {
        const app = customApps.find((a) => a.id === tab.customAppId);
        return app?.label ?? 'App';
      }
      if (!tab.projectId) {
        // Chat column: the conversation's title once it has one, else the
        // fresh-column label.
        return (tab.sessionId ? sessionTitles.get(tab.sessionId) : undefined) ?? 'New chat';
      }
      return projectMap.get(tab.projectId)?.label ?? 'Unknown';
    },
    [projectMap, customApps, sessionTitles]
  );

  const resolveTicketTitle = useCallback((tab: CodeTab) => tab.ticketTitle ?? null, []);
  const resolveRoutineName = useCallback((tab: CodeTab) => tab.routineName ?? null, []);
  const resolveRoutineSchedule = useCallback((tab: CodeTab) => tab.routineSchedule ?? null, []);

  const handleOpenSpaces = useCallback(() => {
    codeApi.setLayoutMode('tile');
  }, []);

  const handleFocusColumn = useCallback((tabId: CodeTabId) => {
    codeApi.setActiveTab(tabId);
    codeApi.setLayoutMode('focus');
  }, []);

  const handleNewSession = useCallback(() => {
    codeApi.addTab();
  }, []);

  const handleOpenApps = useCallback(() => {
    void codeApi.addAppTab(APP_LAUNCHER_ID);
  }, []);

  const getColumnWidth = useCallback(
    (tabId: CodeTabId) => {
      const custom = columnWidths[tabId];
      if (custom !== undefined && viewportWidth > SNAP_SCROLL_WIDTH) {
        return custom;
      }
      if (expandedTabIds.has(tabId)) {
        if (viewportWidth <= SNAP_SCROLL_WIDTH) {
          return viewportWidth;
        }
        return Math.min(EXPANDED_COLUMN_WIDTH, Math.round(viewportWidth * 0.92));
      }
      if (viewportWidth <= SNAP_SCROLL_WIDTH) {
        return Math.round(viewportWidth * 0.92);
      }
      if (viewportWidth <= NARROW_DECK_WIDTH) {
        return COLUMN_WIDTH_SMALL;
      }
      return COLUMN_WIDTH;
    },
    [columnWidths, expandedTabIds, viewportWidth]
  );

  const getTabColumnWidth = useCallback(
    (tab: CodeTab) => {
      // A chat column without a manual width gets a roomier default — prose
      // reads better wide — but resize/expand behave like any other column.
      if (isChatColumn(tab) && columnWidths[tab.id] === undefined && !expandedTabIds.has(tab.id)) {
        const availableWidth = deckViewportWidth || viewportWidth;
        if (availableWidth <= SNAP_SCROLL_WIDTH) {
          return Math.round(availableWidth * 0.92);
        }
        if (availableWidth <= NARROW_DECK_WIDTH) {
          return COLUMN_WIDTH_SMALL;
        }
        return Math.min(LAUNCH_COLUMN_MAX_WIDTH, Math.round(availableWidth * 0.62));
      }
      return getColumnWidth(tab.id);
    },
    [deckViewportWidth, getColumnWidth, viewportWidth, columnWidths, expandedTabIds]
  );

  const handleResizeCommit = useCallback((tabId: CodeTabId, width: number) => {
    // The panel group also emits onResize while it fills or tracks its
    // container. Only a separator gesture represents a user-selected width.
    if (!isUserResizingTileRef.current) {
      return;
    }
    const nextWidth = Math.round(width);
    pendingColumnWidthsRef.current[tabId] = nextWidth;
    setColumnWidths((prev) => (prev[tabId] === nextWidth ? prev : { ...prev, [tabId]: nextWidth }));
  }, []);

  const handleResizeStart = useCallback(() => {
    isUserResizingTileRef.current = true;
  }, []);

  const handleResizeEnd = useCallback(() => {
    isUserResizingTileRef.current = false;
    const pending = pendingColumnWidthsRef.current;
    pendingColumnWidthsRef.current = {};
    const ids = Object.keys(pending);
    if (ids.length === 0) {
      return;
    }
    setExpandedTabIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.delete(id);
      }
      return next;
    });
    void codeApi.setSpacesColumnLayouts(
      Object.fromEntries(ids.map((id) => [id, { width: pending[id], expanded: false }]))
    );
  }, []);

  const handleToggleExpand = useCallback(
    (id: CodeTabId) => {
      // The expand preset replaces any manual drag width (and vice versa).
      const expanded = !expandedTabIds.has(id);
      setColumnWidths((prev) => {
        if (!(id in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setExpandedTabIds((current) => {
        const next = new Set(current);
        if (expanded) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
      void codeApi.setSpacesColumnLayouts({ [id]: { width: null, expanded } });
    },
    [expandedTabIds]
  );

  const handleArchive = useCallback(
    async (id: CodeTabId) => {
      setColumnWidths((current) => {
        if (!(id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPreviewUrls((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setExpandedTabIds((current) => {
        if (!current.has(id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      const tab = tabs.find((candidate) => candidate.id === id);
      const title = tab?.sessionId ? sessionTitles.get(tab.sessionId) : undefined;
      await codeApi.archiveTab(id, title);
    },
    [sessionTitles, tabs]
  );

  const handleOpenSidecarApp = useCallback((tabId: CodeTabId, app: AppId) => {
    void codeApi.openSidecarApp(tabId, app);
  }, []);

  const handleActivateSidecarApp = useCallback((tabId: CodeTabId, app: AppId) => {
    void codeApi.setActiveSidecarApp(tabId, app);
  }, []);

  const handleCloseSidecarApp = useCallback((tabId: CodeTabId, app: AppId) => {
    void codeApi.closeSidecarApp(tabId, app);
  }, []);

  const handleSidecarOpenChange = useCallback((tabId: CodeTabId, open: boolean) => {
    void codeApi.setSidecarOpen(tabId, open);
  }, []);

  const handlePreviewUrlChange = useCallback((tabId: CodeTabId, url: string) => {
    // Idempotent on purpose: BrowserView re-reports the active URL whenever
    // its sync effect re-runs, and the inline arrow prop below renews its
    // identity every render. Returning the same reference lets React bail
    // out instead of looping render → new arrow → effect → setState.
    setPreviewUrls((prev) => (prev[tabId] === url ? prev : { ...prev, [tabId]: url }));
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      if (isEditable) {
        return;
      }
      if (!activeTabId) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setExpandedTabIds((current) => {
          const next = new Set(current);
          if (next.has(activeTabId)) {
            next.delete(activeTabId);
          } else {
            next.add(activeTabId);
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId]);

  const renderSessionActions = useCallback(
    (tab: CodeTab) => (
      <Toggle
        size="sm"
        pressed={tab.sidecarOpen ?? Boolean(tab.sidecarAppIds?.length)}
        aria-label={(tab.sidecarOpen ?? Boolean(tab.sidecarAppIds?.length)) ? 'Hide apps' : 'Show apps'}
        title={(tab.sidecarOpen ?? Boolean(tab.sidecarAppIds?.length)) ? 'Hide apps' : 'Show apps'}
        onPressedChange={(open) => handleSidecarOpenChange(tab.id, open)}
      >
        <PanelRight className="size-4" />
      </Toggle>
    ),
    [handleSidecarOpenChange]
  );

  const renderTicketColumnBadge = useCallback((tab: CodeTab) => {
    if (!tab.ticketId) {
      return undefined;
    }
    return <TicketColumnBadge ticketId={tab.ticketId} />;
  }, []);

  const renderTicketBannerActions = useCallback((tab: CodeTab) => {
    if (!tab.ticketId) {
      return undefined;
    }
    return <TicketBannerActions ticketId={tab.ticketId} />;
  }, []);

  const renderTicketMetaBadge = useCallback(
    (tab: CodeTab) => {
      if (!tab.ticketId) {
        return undefined;
      }

      const ticket = store.tickets.find((item) => item.id === tab.ticketId);
      if (!ticket) {
        return undefined;
      }

      const milestone = store.milestones.find((item) => item.id === ticket.milestoneId);
      const effectiveBranch = ticket.branch ?? milestone?.branch;
      const projectWorkspaceDir = tab.projectId ? projectMap.get(tab.projectId)?.workspaceDir : undefined;
      const isIsolatedWorkspace =
        !!tab.workspaceDir && !!projectWorkspaceDir && tab.workspaceDir !== projectWorkspaceDir;

      if (!effectiveBranch && !isIsolatedWorkspace) {
        return undefined;
      }

      return (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
          <GitFork className="size-3" />
          {effectiveBranch ?? 'Isolated workspace'}
          {isIsolatedWorkspace ? ' · isolated' : ''}
          {!ticket.branch && milestone?.branch ? ' · inherited' : ''}
        </span>
      );
    },
    [projectMap, store.milestones, store.tickets]
  );

  type SidecarState = {
    apps: AppDescriptor[];
    activeAppId: AppId | undefined;
    availableApps: AppDescriptor[];
    visible: boolean;
  };
  const sidecarStateByTab = new Map<CodeTabId, SidecarState>();
  const visibleSidecarsByTab = new Map<CodeTabId, SidecarState>();
  for (const tab of sessionTabs) {
    const apps = (tab.sidecarAppIds ?? [])
      .map((appId) => appRegistry.find((app) => app.id === appId && app.columnScoped && app.id !== 'chat'))
      .filter((app): app is AppDescriptor => Boolean(app));
    const sandboxStatus = statuses[tab.id];
    const sandboxUrls = sandboxStatus?.type === 'running' ? sandboxStatus.data : undefined;
    const availableApps = appRegistry.filter((app) => {
      if (!app.columnScoped || app.id === 'chat') {
        return false;
      }
      if (app.kind === 'builtin-files' || app.kind === 'builtin-git' || app.kind === 'builtin-terminal') {
        return Boolean(sandboxUrls);
      }
      if (app.scope !== 'sandbox') {
        return true;
      }
      return app.sandboxUrlKey === 'codeServerUrl'
        ? Boolean(sandboxUrls?.services?.['code_server'])
        : Boolean(sandboxUrls?.services?.['vnc']);
    });
    const activeAppId =
      apps.length === 0
        ? undefined
        : apps.some((app) => app.id === tab.activeSidecarAppId)
          ? (tab.activeSidecarAppId as AppId)
          : apps[apps.length - 1]!.id;
    const sidecarState = {
      apps,
      activeAppId,
      availableApps,
      visible: tab.sidecarOpen ?? apps.length > 0,
    };
    sidecarStateByTab.set(tab.id, sidecarState);
    if (sidecarState.visible) {
      visibleSidecarsByTab.set(tab.id, sidecarState);
    }
  }
  const activeSidecar = activeTab ? visibleSidecarsByTab.get(activeTab.id) : undefined;
  const activeSandboxStatus = activeTab ? statuses[activeTab.id] : undefined;
  const hasVisibleTileDock = sessionTabs.some((tab) => statuses[tab.id]?.type === 'running');
  const hasVisibleFocusDock = activeSandboxStatus?.type === 'running';
  const tilePreferredWidths = new Map<CodeTabId, number>();
  for (const tab of tabs) {
    tilePreferredWidths.set(tab.id, getTabColumnWidth(tab));
    if (visibleSidecarsByTab.has(tab.id)) {
      tilePreferredWidths.set(`sidecar:${tab.id}`, getColumnWidth(`sidecar:${tab.id}`));
    }
  }
  const tilePreferredTotal = [...tilePreferredWidths.values()].reduce((total, width) => total + width, 0);
  const tilePanelGroupWidth = Math.max(deckViewportWidth, tilePreferredTotal);
  const tileFillScale = tilePreferredTotal > 0 ? tilePanelGroupWidth / tilePreferredTotal : 1;
  const tilePanelWidths = new Map<CodeTabId, number>();
  let assignedTileWidth = 0;
  const tileWidthEntries = [...tilePreferredWidths.entries()];
  tileWidthEntries.forEach(([id, preferredWidth], index) => {
    const width =
      index === tileWidthEntries.length - 1
        ? tilePanelGroupWidth - assignedTileWidth
        : Math.round(preferredWidth * tileFillScale);
    tilePanelWidths.set(id, width);
    assignedTileWidth += width;
  });
  const getTilePanelWidth = (id: CodeTabId) => tilePanelWidths.get(id) ?? MIN_COLUMN_WIDTH;
  const getTilePanelMaxWidth = (id: CodeTabId) => Math.max(MAX_COLUMN_WIDTH, getTilePanelWidth(id));
  const tileLayoutKey = `${tabs.map((tab) => tab.id).join(':')}|${[...expandedTabIds].sort().join(':')}|${[
    ...visibleSidecarsByTab.keys(),
  ].join(':')}`;

  return (
    <LayoutGroup>
      <div className="flex flex-col w-full h-full min-h-0 overflow-hidden bg-background">
        <CodeDeckHeader
          layoutMode={layoutMode}
          onOpenSpaces={handleOpenSpaces}
          onNewSession={handleNewSession}
          onOpenApps={handleOpenApps}
        />

        {/* Archiving the last session leaves the deck genuinely empty — nothing
               re-mints a column behind the user's back. (The boot landing still
               opens a fresh chat on app launch; that's a launch gesture.) */}
        {tabs.length === 0 && (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">No active sessions</EmptyTitle>
                <EmptyDescription>
                  Start a chat, or launch an app from the header. Archived sessions can be restored from the sidebar.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="default" onClick={handleNewSession}>
                  <Plus />
                  New chat
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}
        {layoutMode === 'tile' && tabs.length > 0 && (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              <div
                ref={deckScrollRef}
                className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden scrollbar-none [&::-webkit-scrollbar]:hidden [@media(max-width:540px)]:snap-x snap-mandatory [@media(max-width:540px)]:touch-pan-x"
              >
                <ResizablePanelGroup
                  key={tileLayoutKey}
                  orientation="horizontal"
                  className={cn(
                    'flex h-full flex-none overflow-y-hidden',
                    hasVisibleTileDock && '[&_.deckDockSlot]:min-h-14.5'
                  )}
                  style={{ width: tilePanelGroupWidth }}
                >
                  {tabs.map((tab, tabIndex) => {
                    const isLauncher = tab.customAppId === APP_LAUNCHER_ID;
                    const appEntry =
                      tab.customAppId && !isLauncher ? customApps.find((a) => a.id === tab.customAppId) : undefined;
                    const sidecar = !isLauncher && !appEntry ? visibleSidecarsByTab.get(tab.id) : undefined;
                    return (
                      <Fragment key={tab.id}>
                        <ResizablePanel
                          id={tab.id}
                          defaultSize={getTilePanelWidth(tab.id)}
                          minSize={MIN_COLUMN_WIDTH}
                          maxSize={getTilePanelMaxWidth(tab.id)}
                          groupResizeBehavior="preserve-relative-size"
                          onResize={(size) => handleResizeCommit(tab.id, size.inPixels)}
                          className="flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden relative [@media(max-width:540px)]:snap-start"
                          data-deck-column={tab.id}
                        >
                          {isLauncher ? (
                            <AppLauncherColumn
                              tab={tab}
                              customApps={customApps}
                              onClose={handleArchive}
                              onFocus={handleFocusColumn}
                              isExpanded={expandedTabIds.has(tab.id)}
                              onToggleExpand={handleToggleExpand}
                            />
                          ) : appEntry?.id === BROWSER_APP_ID ? (
                            <BrowserColumn
                              tab={tab}
                              onClose={handleArchive}
                              onFocus={handleFocusColumn}
                              isExpanded={expandedTabIds.has(tab.id)}
                              onToggleExpand={handleToggleExpand}
                            />
                          ) : appEntry ? (
                            <AppColumn
                              tab={tab}
                              app={appEntry}
                              onClose={handleArchive}
                              onFocus={handleFocusColumn}
                              isExpanded={expandedTabIds.has(tab.id)}
                              onToggleExpand={handleToggleExpand}
                            />
                          ) : (
                            <DeckColumn
                              tab={tab}
                              label={resolveLabel(tab)}
                              ticketTitle={resolveTicketTitle(tab)}
                              routineName={resolveRoutineName(tab)}
                              routineSchedule={resolveRoutineSchedule(tab)}
                              ticketColumnBadge={renderTicketColumnBadge(tab)}
                              ticketMetaBadge={renderTicketMetaBadge(tab)}
                              ticketActions={renderTicketBannerActions(tab)}
                              actions={renderSessionActions(tab)}
                              onArchive={handleArchive}
                              onFocus={handleFocusColumn}
                              isExpanded={expandedTabIds.has(tab.id)}
                              onToggleExpand={handleToggleExpand}
                              headerActionsSlot={<div id={`code-deck-header-actions-${tab.id}`} />}
                              hasSidecar={Boolean(sidecar)}
                            >
                              <TabContentSlot host={getContentHost(tab.id)} />
                            </DeckColumn>
                          )}
                        </ResizablePanel>
                        {sidecar && (
                          <>
                            <ResizableHandle
                              className="omni-code-deck-resize-handle"
                              onPointerDown={handleResizeStart}
                              onPointerUp={handleResizeEnd}
                              onKeyDown={handleResizeStart}
                              onKeyUp={handleResizeEnd}
                              onBlur={handleResizeEnd}
                            />
                            <ResizablePanel
                              id={`sidecar:${tab.id}`}
                              defaultSize={getTilePanelWidth(`sidecar:${tab.id}`)}
                              minSize={MIN_COLUMN_WIDTH}
                              maxSize={getTilePanelMaxWidth(`sidecar:${tab.id}`)}
                              groupResizeBehavior="preserve-relative-size"
                              onResize={(size) => handleResizeCommit(`sidecar:${tab.id}`, size.inPixels)}
                              className="flex flex-col w-full h-full min-w-0 min-h-0 overflow-hidden relative [@media(max-width:540px)]:snap-start"
                            >
                              <SidecarColumn
                                apps={sidecar.apps}
                                activeAppId={sidecar.activeAppId}
                                availableApps={sidecar.availableApps}
                                getAppHost={(appId) => getSidecarHost(tab.id, appId)}
                                onActivate={(appId) => handleActivateSidecarApp(tab.id, appId)}
                                onCloseApp={(appId) => handleCloseSidecarApp(tab.id, appId)}
                                onOpenApp={(appId) => handleOpenSidecarApp(tab.id, appId)}
                                isExpanded={expandedTabIds.has(`sidecar:${tab.id}`)}
                                onToggleExpand={() => handleToggleExpand(`sidecar:${tab.id}`)}
                              />
                            </ResizablePanel>
                          </>
                        )}
                        {tabIndex < tabs.length - 1 && (
                          <ResizableHandle
                            className="omni-code-deck-resize-handle"
                            onPointerDown={handleResizeStart}
                            onPointerUp={handleResizeEnd}
                            onKeyDown={handleResizeStart}
                            onKeyUp={handleResizeEnd}
                            onBlur={handleResizeEnd}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </ResizablePanelGroup>
              </div>
            </SortableContext>
          </DndContext>
        )}
        {layoutMode === 'tile' && (
          <DeckMap tabs={tabs} currentTabId={pagerTabId} resolveLabel={resolveLabel} onSelect={scrollToColumn} />
        )}
        {layoutMode === 'focus' && tabs.length > 0 && (
          <div
            className={cn(
              'flex-1 min-h-0 flex flex-col [@media(min-width:541px)]:flex-row',
              hasVisibleFocusDock && '[&_.deckDockSlot]:min-h-14.5'
            )}
          >
            <ResizablePanelGroup
              key={`focus:${activeTab?.id ?? 'none'}:${activeSidecar ? 'split' : 'chat'}`}
              orientation={viewportWidth <= SNAP_SCROLL_WIDTH ? 'vertical' : 'horizontal'}
              className="flex-1 min-w-0 min-h-0"
            >
              <ResizablePanel
                id={`focus:${activeTab?.id ?? 'none'}`}
                defaultSize={activeSidecar ? '50%' : '100%'}
                minSize={activeSidecar ? '30%' : undefined}
                className="flex-1 min-w-0 min-h-0"
              >
                {tabs.map((tab) => {
                  const isLauncher = tab.customAppId === APP_LAUNCHER_ID;
                  const appEntry =
                    tab.customAppId && !isLauncher ? customApps.find((a) => a.id === tab.customAppId) : undefined;
                  if (isLauncher) {
                    return (
                      <div
                        key={tab.id}
                        className={cn('h-full w-full flex-col', tab.id === activeTab?.id ? 'flex' : 'hidden')}
                      >
                        <div
                          className={cn(
                            'flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center pt-12 pl-8 pr-8 pb-12 bg-card'
                          )}
                        >
                          {customApps.length === 0 ? (
                            <div className="text-muted-foreground text-xs text-center pt-8">
                              No apps installed. Add apps in Settings.
                            </div>
                          ) : (
                            <AppLauncherGrid apps={customApps} onPick={(appId) => codeApi.setTabAppId(tab.id, appId)} />
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (appEntry?.id === BROWSER_APP_ID) {
                    return (
                      <div
                        key={tab.id}
                        className={cn('h-full w-full flex-col', tab.id === activeTab?.id ? 'flex' : 'hidden')}
                      >
                        <BrowserView tabsetId={`col:${tab.id}`} />
                      </div>
                    );
                  }
                  if (appEntry) {
                    const scope: AppHandleScope = appEntry.columnScoped ? 'column' : 'global';
                    return (
                      <div key={tab.id} className={tab.id === activeTab?.id ? 'block size-full' : 'hidden'}>
                        <Webview
                          src={appEntry.url}
                          showUnavailable={false}
                          registry={{
                            handleId: makeAppHandleId(scope, appEntry.id, scope === 'column' ? tab.id : undefined),
                            appId: appEntry.id,
                            kind: 'webview',
                            scope,
                            ...(scope === 'column' ? { tabId: tab.id } : {}),
                            label: appEntry.label,
                          }}
                        />
                      </div>
                    );
                  }
                  return (
                    <CodeSessionPane
                      key={tab.id}
                      tab={tab}
                      label={resolveLabel(tab)}
                      ticketTitle={resolveTicketTitle(tab)}
                      routineName={resolveRoutineName(tab)}
                      routineSchedule={resolveRoutineSchedule(tab)}
                      ticketColumnBadge={renderTicketColumnBadge(tab)}
                      ticketMetaBadge={renderTicketMetaBadge(tab)}
                      ticketActions={renderTicketBannerActions(tab)}
                      actions={renderSessionActions(tab)}
                      onArchive={handleArchive}
                      isVisible={tab.id === activeTab?.id}
                      content={<TabContentSlot host={getContentHost(tab.id)} />}
                    />
                  );
                })}
              </ResizablePanel>
              {activeTab && activeSidecar && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id={`focus-sidecar:${activeTab.id}`}
                    defaultSize="50%"
                    minSize="30%"
                    className="flex-1 min-w-0 min-h-0"
                  >
                    <SidecarColumn
                      apps={activeSidecar.apps}
                      activeAppId={activeSidecar.activeAppId}
                      availableApps={activeSidecar.availableApps}
                      getAppHost={(appId) => getSidecarHost(activeTab.id, appId)}
                      onActivate={(appId) => handleActivateSidecarApp(activeTab.id, appId)}
                      onCloseApp={(appId) => handleCloseSidecarApp(activeTab.id, appId)}
                      onOpenApp={(appId) => handleOpenSidecarApp(activeTab.id, appId)}
                      isExpanded={expandedTabIds.has(`sidecar:${activeTab.id}`)}
                      onToggleExpand={() => handleToggleExpand(`sidecar:${activeTab.id}`)}
                      canExpand={false}
                      presentation="focus"
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        )}
        {sessionTabs.map((tab) => {
          const tile = layoutMode === 'tile';
          return createPortal(
            <CodeTabContent
              tab={tab}
              isVisible={tile || tab.id === activeTab?.id}
              activeApp={sidecarStateByTab.get(tab.id)?.activeAppId ?? 'chat'}
              onActiveAppChange={(app) => handleOpenSidecarApp(tab.id, app)}
              uiMinimal
              headerActionsTargetId={tile ? `code-deck-header-actions-${tab.id}` : undefined}
              headerActionsCompact
              dockTargetId={tile ? `code-deck-dock-target-${tab.id}` : undefined}
              filesHost={getFilesHost(tab.id)}
              gitHost={getGitHost(tab.id)}
            />,

            getContentHost(tab.id),
            `tab-content-${tab.id}`
          );
        })}
        {sessionTabs.flatMap((tab) => {
          const sidecar = sidecarStateByTab.get(tab.id);
          if (!sidecar) {
            return [];
          }
          const sandboxStatus = statuses[tab.id];
          const sandboxUrls = sandboxStatus?.type === 'running' ? sandboxStatus.data : undefined;
          return sidecar.apps.map((app) =>
            createPortal(
              <SidecarBody
                app={app}
                originTabId={tab.id}
                filesHost={getFilesHost(tab.id)}
                gitHost={getGitHost(tab.id)}
                sandboxUrls={sandboxUrls}
                previewUrl={previewUrls[tab.id]}
                onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
              />,
              getSidecarHost(tab.id, app.id),
              `sidecar-content-${tab.id}-${app.id}`
            )
          );
        })}
      </div>
    </LayoutGroup>
  );
});
CodeDeck.displayName = 'CodeDeck';
