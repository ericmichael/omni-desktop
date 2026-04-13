import { DndContext, PointerSensor, type DragEndEvent, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '@nanostores/react';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowMinimize20Regular, ArrowMaximize20Regular, ReOrderDotsVertical20Regular, MoreHorizontal20Regular, BranchFork20Regular, Add20Regular, Navigation20Regular } from '@fluentui/react-icons';

import { uuidv4 } from '@/lib/uuid';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { Button, cn, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, SegmentedControl } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeLayoutMode, CodeTab, CodeTabId, TicketId, TicketResolution } from '@/shared/types';

import { CodeTabContent } from './CodeTabContent';
import type { DockPane } from './EnvironmentDock';
import { TicketBannerActions, TicketColumnBadge, TicketResolutionBadge } from '@/renderer/features/Tickets/TicketControls';
import { type TicketPanel, TicketPanelOverlay } from '@/renderer/features/Tickets/TicketPanelOverlay';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { $previewRequest, clearPreviewRequest } from '@/renderer/features/Tickets/preview-bridge';
import { $codeTabStatuses, codeApi } from './state';

const COLUMN_WIDTH = 480;
const COLUMN_WIDTH_SMALL = 360;
const EXPANDED_COLUMN_WIDTH = 860;
/** Below this width, deck columns use COLUMN_WIDTH_SMALL. */
const NARROW_DECK_WIDTH = 800;
/** Below this width, deck columns snap-scroll at ~92% viewport width. */
const SNAP_SCROLL_WIDTH = 540;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
  deckHeader: {
    display: 'flex',
    height: '40px',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  deckHeaderNav: {
    display: 'flex',
    alignItems: 'center',
    [`@media (min-width: ${SNAP_SCROLL_WIDTH + 1}px)`]: { display: 'none' },
  },
  deckHeaderActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  flexItemsCenter: { display: 'flex', alignItems: 'center' },
  gap1: { gap: '4px' },
  gap2: { gap: tokens.spacingHorizontalS },
  gap3: { gap: tokens.spacingHorizontalM },
  minW0: { minWidth: 0 },
  sessionActionBtn: {
    display: 'inline-flex',
    width: '32px',
    height: '32px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  sessionActionBtnDisabled: {
    cursor: 'not-allowed',
    opacity: 0.4,
    ':hover': { backgroundColor: 'transparent', color: tokens.colorNeutralForeground2 },
  },
  sessionHeader: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  sessionLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ticketBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    '@media (min-width: 640px)': {
      paddingLeft: tokens.spacingHorizontalXL,
      paddingRight: tokens.spacingHorizontalXL,
    },
  },
  ticketTitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ticketBadges: {
    display: 'none',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
    '@media (min-width: 640px)': { display: 'flex' },
  },
  ticketActions: {
    display: 'none',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    marginLeft: tokens.spacingHorizontalS,
    '@media (min-width: 640px)': { display: 'flex' },
  },
  deckColumn: {
    display: 'flex',
    height: '100%',
    flexDirection: 'column',
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  deckColumnDragging: { opacity: 0.7 },
  dragHandle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'grab',
    ':hover': { color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  flex1MinH0Relative: { flex: '1 1 0', minHeight: 0, position: 'relative' },
  sessionPane: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground2 },
  sessionPaneHidden: { display: 'none' },
  focusListItem: { position: 'relative' },
  focusListItemDragging: { opacity: 0.7 },
  focusListItemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    textAlign: 'left',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
  },
  focusListItemActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  focusListItemInactive: { color: tokens.colorNeutralForeground2, ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 } },
  focusListItemContent: { flex: '1 1 0', minWidth: 0, textAlign: 'left', border: 'none', backgroundColor: 'transparent', cursor: 'pointer' },
  focusListItemInner: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  focusListItemLabel: { fontSize: tokens.fontSizeBase300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  focusListItemSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  deckScroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    [`@media (max-width: ${SNAP_SCROLL_WIDTH}px)`]: {
      scrollSnapType: 'x mandatory',
      WebkitOverflowScrolling: 'touch',
    },
  },
  deckInner: { display: 'flex', height: '100%', minWidth: 'max-content', overflowY: 'hidden' },
  deckColumnWrap: {
    height: '100%',
    flexShrink: 0,
    [`@media (max-width: ${SNAP_SCROLL_WIDTH}px)`]: {
      scrollSnapAlign: 'start',
    },
  },
  focusLayout: { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', [`@media (min-width: ${SNAP_SCROLL_WIDTH + 1}px)`]: { flexDirection: 'row' } },
  focusSidebar: {
    display: 'none',
    flexDirection: 'column',
    height: '100%',
    width: '240px',
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    flexShrink: 0,
    [`@media (min-width: ${SNAP_SCROLL_WIDTH + 1}px)`]: { display: 'flex' },
  },
  focusSidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  focusSidebarTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  focusSidebarCount: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  focusSidebarList: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', paddingTop: '4px', paddingBottom: '4px' },
  focusContent: { flex: '1 1 0', minWidth: 0, minHeight: 0 },
  mobileTabBar: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    overflowX: 'auto',
    [`@media (min-width: ${SNAP_SCROLL_WIDTH + 1}px)`]: { display: 'none' },
  },
  mobileTabBarInner: { display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: tokens.spacingHorizontalS, paddingTop: '6px', paddingBottom: '6px' },
  mobileTabChip: {
    flexShrink: 0,
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: '9999px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    border: 'none',
    cursor: 'pointer',
  },
  mobileTabChipActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1 },
  mobileTabChipInactive: { backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2 },
  mobileNewBtn: {
    flexShrink: 0,
    width: '36px',
    height: '36px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    border: 'none',
    cursor: 'pointer',
  },
  mobileNavBtn: {
    flexShrink: 0,
    width: '36px',
    height: '36px',
    borderRadius: '9999px',
    color: tokens.colorNeutralForeground2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  metaBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    borderRadius: '9999px',
    backgroundColor: 'rgba(192, 132, 252, 0.1)',
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: 'rgb(192, 132, 252)',
    flexShrink: 0,
  },
});

const CodeDeckHeader = memo(
  ({ layoutMode, onLayoutMode, onNewSession }: { layoutMode: CodeLayoutMode; onLayoutMode: (mode: CodeLayoutMode) => void; onNewSession: () => void }) => {
    const styles = useStyles();
    return (
      <div className={styles.deckHeader}>
        <div className={styles.deckHeaderNav}>
          <Menu positioning={{ position: 'below', align: 'start' }}>
            <MenuTrigger>
              <button type="button" className={styles.mobileNavBtn} aria-label="Navigate">
                <Navigation20Regular style={{ width: 18, height: 18 }} />
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => onLayoutMode(layoutMode === 'deck' ? 'focus' : 'deck')}>
                  Switch to {layoutMode === 'deck' ? 'Focus' : 'Deck'}
                </MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'chat')}>Chat</MenuItem>
                <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'projects')}>Projects</MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'settings')}>Settings</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
        <div className={styles.deckHeaderActions}>
          <SegmentedControl
            value={layoutMode}
            options={[{ value: 'deck', label: 'Deck' }, { value: 'focus', label: 'Focus' }]}
            onChange={onLayoutMode}
            layoutId="code-layout-toggle"
          />
          <Button size="sm" variant="ghost" leftIcon={<Add20Regular style={{ width: 13, height: 13 }} />} onClick={onNewSession}>
            New Session
          </Button>
        </div>
      </div>
    );
  }
);
CodeDeckHeader.displayName = 'CodeDeckHeader';

const SessionActionButton = forwardRef<HTMLButtonElement, { icon: React.ReactNode; label: string; isDisabled?: boolean; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }>(
  ({ icon, label, isDisabled, onClick, ...rest }, ref) => {
    const styles = useStyles();
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        disabled={isDisabled}
        onClick={onClick}
        className={mergeClasses(styles.sessionActionBtn, isDisabled && styles.sessionActionBtnDisabled)}
        {...rest}
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
    const handleResolve = useCallback(
      (resolution: TicketResolution) => {
        if (ticketId) {
          ticketApi.resolveTicket(ticketId, resolution);
        }
      },
      [ticketId]
    );

    const styles = useStyles();
    return (
      <>
        <div className={styles.sessionHeader}>
          <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
            {dragHandle}
            <span className={styles.sessionLabel}>{label}</span>
          </div>
          <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
            {actions}
            {onClose && (
              <Menu positioning={{ position: 'below', align: 'end', fallbackPositions: ['above-end'] }}>
                <MenuTrigger>
                  <SessionActionButton
                    icon={<MoreHorizontal20Regular style={{ width: 16, height: 16 }} />}
                    label="Session menu"
                  />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {ticketId && onOpenPanel && (
                      <>
                        <MenuItem onClick={() => onOpenPanel('overview')}>Overview</MenuItem>
                        <MenuItem onClick={() => onOpenPanel('pr')}>PR</MenuItem>
                        <MenuItem onClick={() => onOpenPanel('artifacts')}>Artifacts</MenuItem>
                        <MenuDivider />
                      </>
                    )}
                    {ticketId && (
                      <>
                        {RESOLUTIONS.map((res) => (
                          <MenuItem key={res.value} onClick={() => handleResolve(res.value)}>
                            {res.label}
                          </MenuItem>
                        ))}
                        <MenuDivider />
                      </>
                    )}
                    <MenuItem onClick={onClose}>Close session</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
          </div>
        </div>
        {ticketTitle && (
          <div className={styles.ticketBanner}>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
              <span className={styles.ticketTitle}>{ticketTitle}</span>
              <span className={styles.ticketBadges}>
                {ticketColumnBadge}
                {ticketMetaBadge}
              </span>
            </div>
            {ticketActions && <div className={styles.ticketActions}>{ticketActions}</div>}
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

    const styles = useStyles();
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={mergeClasses(styles.deckColumn, isDragging && styles.deckColumnDragging)}
      >
        <CodeSessionHeader
          label={label}
          ticketTitle={ticketTitle}
          ticketColumnBadge={ticketColumnBadge}
          ticketMetaBadge={ticketMetaBadge}
          ticketActions={ticketActions}
          actions={
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
              {headerActionsSlot}
              {actions}
              <SessionActionButton
                icon={isExpanded ? <ArrowMinimize20Regular style={{ width: 15, height: 15 }} /> : <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />}
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
              className={styles.dragHandle}
              {...attributes}
              {...listeners}
              aria-label="Reorder"
            >
              <ReOrderDotsVertical20Regular style={{ width: 16, height: 16 }} />
            </button>
          }
        />
        <div className={styles.flex1MinH0Relative}>
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
    onOpenOverlay,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    previewUrl,
    onPreviewUrlChange,
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
    overlayPane: DockPane;
    onCloseOverlay: () => void;
    onOpenOverlay?: (pane: Exclude<DockPane, 'none'>) => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    previewUrl?: string;
    onPreviewUrlChange?: (url: string) => void;
  }) => {
    const styles = useStyles();
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);

    return (
      <div className={mergeClasses(styles.sessionPane, !isVisible && styles.sessionPaneHidden)}>
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
        <div className={styles.flex1MinH0Relative}>
          <CodeTabContent
            tab={tab}
            isVisible={isVisible}
            overlayPane={overlayPane}
            onCloseOverlay={onCloseOverlay}
            onOpenOverlay={onOpenOverlay}
            uiMinimal={uiMinimal}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
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
    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
    };

    const styles = useStyles();
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={mergeClasses(styles.focusListItem, isDragging && styles.focusListItemDragging)}
    >
      <div
        className={mergeClasses(
          styles.focusListItemRow,
          isActive ? styles.focusListItemActive : styles.focusListItemInactive
        )}
      >
        <button
          type="button"
          className={styles.dragHandle}
          {...attributes}
          {...listeners}
          aria-label="Reorder"
        >
          <ReOrderDotsVertical20Regular style={{ width: 14, height: 14 }} />
        </button>
        <button type="button" onClick={() => onSelect(tab.id)} className={styles.focusListItemContent}>
          <div className={styles.focusListItemInner}>
            <span className={styles.focusListItemLabel}>{label}</span>
            {subLabel && <span className={styles.focusListItemSub}>{subLabel}</span>}
          </div>
        </button>
        <Menu positioning={{ position: 'below', align: 'end', fallbackPositions: ['above-end'] }}>
          <MenuTrigger>
            <SessionActionButton
              icon={<MoreHorizontal20Regular style={{ width: 16, height: 16 }} />}
              label="Session menu"
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem onClick={() => onClose(tab.id)}>Delete session</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    </div>
  );
  }
);
FocusListItem.displayName = 'FocusListItem';

export const CodeDeck = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const statuses = useStore($codeTabStatuses);
  const tabs = store.codeTabs ?? [];
  const layoutMode = store.codeLayoutMode ?? 'deck';
  const activeTabId = store.activeCodeTabId ?? tabs[0]?.id ?? null;
  const [overlayTarget, setOverlayTarget] = useState<{ tabId: CodeTabId; pane: Exclude<DockPane, 'none'> } | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<CodeTabId, string>>({});
  const [expandedTabId, setExpandedTabId] = useState<CodeTabId | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

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
    if (expandedTabId && !tabs.some((tab) => tab.id === expandedTabId)) {
      setExpandedTabId(null);
    }
  }, [expandedTabId, tabs]);

  // React to agent-triggered preview requests
  const previewRequest = useStore($previewRequest);
  useEffect(() => {
    if (!previewRequest) return;
    const targetTabId = (previewRequest.tabId as CodeTabId | undefined) ?? activeTabId ?? tabs[0]?.id;
    if (!targetTabId) return;
    setPreviewUrls((prev) => ({ ...prev, [targetTabId]: previewRequest.url }));
    setOverlayTarget({ tabId: targetTabId, pane: 'preview' });
    clearPreviewRequest();
  }, [previewRequest, activeTabId, tabs]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectMap = useMemo(() => {
    const map = new Map<string, { label: string; workspaceDir: string | undefined }>();
    for (const p of store.projects) {
      map.set(p.id, { label: p.label, workspaceDir: p.source?.kind === 'local' ? p.source.workspaceDir : undefined });
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

  const getColumnWidth = useCallback(
    (tabId: CodeTabId) => {
      if (expandedTabId === tabId) return EXPANDED_COLUMN_WIDTH;
      if (viewportWidth <= SNAP_SCROLL_WIDTH) return Math.round(viewportWidth * 0.92);
      if (viewportWidth <= NARROW_DECK_WIDTH) return COLUMN_WIDTH_SMALL;
      return COLUMN_WIDTH;
    },
    [expandedTabId, viewportWidth]
  );

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

  const handleOpenOverlay = useCallback((tabId: CodeTabId, pane: Exclude<DockPane, 'none'>) => {
    setOverlayTarget({ tabId, pane });
  }, []);

  const handlePreviewUrlChange = useCallback((tabId: CodeTabId, url: string) => {
    setPreviewUrls((prev) => ({ ...prev, [tabId]: url }));
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
    (tab: CodeTab) => (
      <SessionActionButton
        icon={<Add20Regular style={{ width: 13, height: 13 }} />}
        label="New session"
        onClick={() => handleNewTabSession(tab)}
      />
    ),
    [handleNewTabSession]
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

      const milestone = store.milestones.find((item) => item.id === ticket.milestoneId);
      const effectiveBranch = ticket.branch ?? milestone?.branch;
      const projectWorkspaceDir = tab.projectId ? projectMap.get(tab.projectId)?.workspaceDir : undefined;
      const isIsolatedWorkspace = !!tab.workspaceDir && !!projectWorkspaceDir && tab.workspaceDir !== projectWorkspaceDir;

      if (!effectiveBranch && !isIsolatedWorkspace) {
        return undefined;
      }

      return (
        <span className={styles.metaBadge}>
          <BranchFork20Regular style={{ width: 10, height: 10 }} />
          {effectiveBranch ?? 'Isolated workspace'}
          {isIsolatedWorkspace ? ' · isolated' : ''}
          {!ticket.branch && milestone?.branch ? ' · inherited' : ''}
        </span>
      );
    },
    [projectMap, store.milestones, store.tickets]
  );

  return (
    <div className={styles.root}>
      <CodeDeckHeader layoutMode={layoutMode} onLayoutMode={handleLayoutMode} onNewSession={handleNewSession} />
      {layoutMode === 'deck' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div className={styles.deckScroll}>
              <div className={styles.deckInner}>
                {tabs.map((tab) => {
                  return (
                    <div
                      key={tab.id}
                      style={{ width: getColumnWidth(tab.id) }}
                      className={styles.deckColumnWrap}
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
                          onOpenOverlay={(pane) => handleOpenOverlay(tab.id, pane)}
                          uiMinimal
                          headerActionsTargetId={`code-deck-header-actions-${tab.id}`}
                          headerActionsCompact
                          previewUrl={previewUrls[tab.id]}
                          onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
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
      {layoutMode === 'focus' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className={styles.focusLayout}>
              {/* Mobile chip bar for focus mode — replaces sidebar on small screens */}
              <div className={styles.mobileTabBar}>
                <div className={styles.mobileTabBarInner}>
                  <Menu positioning={{ position: 'below', align: 'start' }}>
                    <MenuTrigger>
                      <button type="button" className={styles.mobileNavBtn} aria-label="Navigate">
                        <Navigation20Regular style={{ width: 18, height: 18 }} />
                      </button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem onClick={() => handleLayoutMode('deck')}>Switch to Deck</MenuItem>
                        <MenuDivider />
                        <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'chat')}>Chat</MenuItem>
                        <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'projects')}>Projects</MenuItem>
                        <MenuDivider />
                        <MenuItem onClick={() => persistedStoreApi.setKey('layoutMode', 'settings')}>Settings</MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => handleSelect(tab.id)}
                      className={mergeClasses(
                        styles.mobileTabChip,
                        tab.id === activeTab?.id
                          ? styles.mobileTabChipActive
                          : styles.mobileTabChipInactive
                      )}
                    >
                      {resolveLabel(tab)}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={handleNewSession}
                    className={styles.mobileNewBtn}
                    aria-label="New session"
                  >
                    <Add20Regular style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              </div>
              <div className={styles.focusSidebar}>
                <div className={styles.focusSidebarHeader}>
                  <span className={styles.focusSidebarTitle}>Sessions</span>
                  {tabs.length > 0 && <span className={styles.focusSidebarCount}>{tabs.length}</span>}
                </div>
                <div className={styles.focusSidebarList}>
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
              <div className={styles.focusContent}>
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
                      onOpenOverlay={(pane) => handleOpenOverlay(tab.id, pane)}
                      uiMinimal={false}
                      headerActionsTargetId={undefined}
                      headerActionsCompact={false}
                      previewUrl={previewUrls[tab.id]}
                      onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
                    />
                ))}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
});
CodeDeck.displayName = 'CodeDeck';
