import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  Apps20Regular,
  ArrowMaximize20Regular,
  ArrowMinimize20Regular,
  BranchFork20Regular,
  Chat20Regular,
  Globe20Regular,
  MoreHorizontal20Regular,
  Navigation20Regular,
  ReOrderDotsVertical20Regular,
  Subtract20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { forwardRef, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { uuidv4 } from '@/lib/uuid';
import { Webview } from '@/renderer/common/Webview';
import { BrowserView } from '@/renderer/features/Browser/BrowserView';
import {
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  SegmentedControl,
} from '@/renderer/ds';
import { $previewRequest, clearPreviewRequest } from '@/renderer/features/Tickets/preview-bridge';
import { ticketApi } from '@/renderer/features/Tickets/state';
import {
  TicketBannerActions,
  TicketColumnBadge,
  TicketResolutionBadge,
} from '@/renderer/features/Tickets/TicketControls';
import { type TicketPanel, TicketPanelOverlay } from '@/renderer/features/Tickets/TicketPanelOverlay';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AppHandleScope } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { AppDescriptor, AppId, CustomAppEntry } from '@/shared/app-registry';
import { buildAppRegistry } from '@/shared/app-registry';
import type { CodeLayoutMode, CodeTab, CodeTabId, TicketId, TicketResolution } from '@/shared/types';

import { AppIcon } from './AppIcon';
import { CodeTabContent } from './CodeTabContent';
import { $codeTabStatuses, codeApi } from './state';

/** Sentinel customAppId meaning "show the app launcher picker". */
const APP_LAUNCHER_ID = '__launcher__';

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
  icon: 'Globe20Regular',
  url: BROWSER_START_URL,
  order: -1,
  columnScoped: false,
};

// URL normalization lives in `@/lib/url` so it's shared with the
// main-process BrowserManager and testable without the DOM.

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
  gap1: { gap: tokens.spacingHorizontalXS },
  gap2: { gap: tokens.spacingHorizontalS },
  gap3: { gap: tokens.spacingHorizontalM },
  minW0: { minWidth: 0 },
  sessionActionBtn: {
    display: 'inline-flex',
    width: '24px',
    height: '24px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color, background-color, opacity',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  revealOnHover: {
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
    '@media (hover: none)': { opacity: 1 },
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
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    minHeight: '32px',
    backgroundColor: 'transparent',
  },
  sessionLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground2,
    letterSpacing: '0.01em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  ticketBanner: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    rowGap: '2px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '2px',
    paddingBottom: tokens.spacingVerticalXS,
    backgroundColor: 'transparent',
  },
  ticketTitle: {
    flex: '1 1 100%',
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (min-width: 640px)': { flex: '1 1 0' },
  },
  ticketBadges: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  ticketActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    marginLeft: 'auto',
  },
  deckColumn: {
    display: 'grid',
    gridTemplateRows: 'subgrid',
    gridRow: 'span 2',
    minHeight: 0,
    backgroundColor: 'transparent',
  },
  deckColumnBordered: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    margin: tokens.spacingHorizontalS,
    backgroundColor: 'transparent',
    ':hover .revealOnHover': { opacity: 1 },
    ':focus-within .revealOnHover': { opacity: 1 },
  },
  deckDockSlot: { minHeight: 0 },
  cardNoRightMargin: {
    marginRight: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  cardFlattenLeft: {
    marginLeft: 0,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: '2px',
  },
  sidecarBodyFill: { position: 'absolute', inset: 0 },
  sidecarBodyHidden: { display: 'none' },
  sidecarUnavailable: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase300,
  },
  glassDeckHeader: {
    backgroundColor: 'transparent',
    backdropFilter: 'none',
    WebkitBackdropFilter: 'none',
    borderBottomColor: 'transparent',
  },
  glassSessionHeader: {
    backgroundColor: 'transparent',
  },
  glassTicketBanner: {
    backgroundColor: 'transparent',
  },
  // Glass surface colors come from --colorNeutralBackground* / --colorNeutralStroke1
  // pushed at the deck-bg root in MainContent. These classes only opt in to the
  // blur layer and any unique embellishments (insets / shadows / shapes).
  glassFocusSidebar: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  glassFocusSidebarHeader: {},
  glassMobileTabBar: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  glassSessionPane: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  glassMobileTabChipInactive: {
    backgroundColor: tokens.colorNeutralBackground3,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
  },
  glassMobileTabChipActive: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 60%, transparent)`,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
  },
  glassCard: {
    backgroundColor: tokens.colorNeutralBackground3,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
    borderRadius: '28px',
    boxShadow: `0 1px 0 0 rgba(255, 255, 255, 0.22) inset, 0 0 0 1px rgba(255, 255, 255, 0.06) inset, 0 30px 80px -24px rgba(0, 0, 0, 0.45), 0 12px 32px -12px rgba(0, 0, 0, 0.3)`,
  },
  deckColumnDragging: { opacity: 0.7 },
  browserToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  browserNavBtn: {
    display: 'inline-flex',
    width: '24px',
    height: '24px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed', ':hover': { backgroundColor: 'transparent' } },
  },
  browserUrlInput: {
    flex: '1 1 0',
    minWidth: 0,
    height: '26px',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    outline: 'none',
    ':focus': { ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  dragHandle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    marginLeft: '-4px',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'grab',
    transitionProperty: 'color, background-color, opacity',
    transitionDuration: tokens.durationFaster,
    ':hover': { color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  dragHandleA11y: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'grab',
    ':focus-visible': {
      position: 'relative',
      width: '20px',
      height: '20px',
      clipPath: 'none',
      overflow: 'visible',
      whiteSpace: 'normal',
      borderRadius: tokens.borderRadiusMedium,
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '1px',
    },
  },
  dragSurface: {
    cursor: 'grab',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    ':active': { cursor: 'grabbing' },
  },
  flex1MinH0Relative: { flex: '1 1 0', minHeight: 0, position: 'relative' },
  sessionPane: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground2,
  },
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
    ':hover .revealOnHover': { opacity: 1 },
    ':focus-within .revealOnHover': { opacity: 1 },
  },
  focusListItemActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  focusListItemInactive: {
    color: tokens.colorNeutralForeground2,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  focusListItemContent: {
    flex: '1 1 0',
    minWidth: 0,
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
  },
  focusListItemInner: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  focusListItemLabel: {
    fontSize: tokens.fontSizeBase300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  focusListItemSub: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
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
  deckInner: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'auto',
    gridTemplateRows: '1fr auto',
    justifyContent: 'start',
    height: '100%',
    minWidth: 'max-content',
    overflowY: 'hidden',
  },
  deckColumnWrap: {
    display: 'grid',
    gridTemplateRows: 'subgrid',
    gridRow: 'span 2',
    minHeight: 0,
    [`@media (max-width: ${SNAP_SCROLL_WIDTH}px)`]: {
      scrollSnapAlign: 'start',
    },
  },
  focusLayout: {
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    [`@media (min-width: ${SNAP_SCROLL_WIDTH + 1}px)`]: { flexDirection: 'row' },
  },
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
  mobileTabBarInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingLeft: tokens.spacingHorizontalS,
    paddingTop: '6px',
    paddingBottom: '6px',
  },
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
  launcherBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: tokens.spacingVerticalXXXL,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingBottom: tokens.spacingVerticalXXXL,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  launcherBodyGlass: {
    backgroundColor: 'transparent',
  },
  launcherGrid: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '24px',
    width: '100%',
  },
  launcherRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: '20px',
  },
  // Fallback honeycomb offset for uniform-width rows (when no hex diamond
  // fits the container). Uses the `translate` CSS property so per-item hover
  // `transform` still composes.
  launcherRowOffset: {
    translate: 'calc((var(--launcher-cell-width) + 20px) / 2) 0',
  },
  launcherItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    width: 'var(--launcher-cell-width)',
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    ':hover': {
      transform: 'translateY(-2px) scale(1.04)',
    },
    ':active': {
      transform: 'translateY(0) scale(0.98)',
    },
  },
  launcherIconDisk: {
    display: 'flex',
    width: '64px',
    height: '64px',
    borderRadius: '50%',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: tokens.colorNeutralForeground1,
    backgroundImage: `linear-gradient(145deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground3})`,
    boxShadow: `0 8px 20px -8px rgba(0, 0, 0, 0.35), inset 0 0 0 1px ${tokens.colorNeutralStroke2}`,
  },
  launcherIconDiskGlass: {
    backgroundImage: 'none',
    backgroundColor: tokens.colorNeutralBackground3,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
    boxShadow: `inset 0 1px 0 0 rgba(255, 255, 255, 0.22), inset 0 0 0 1px rgba(255, 255, 255, 0.10), 0 10px 24px -10px rgba(0, 0, 0, 0.45)`,
  },
  launcherItemLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
    textAlign: 'center',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  launcherEmpty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXL,
  },
});

const CodeDeckHeader = memo(
  ({
    layoutMode,
    onLayoutMode,
    onNewSession,
    onOpenApps,
    isGlass,
  }: {
    layoutMode: CodeLayoutMode;
    onLayoutMode: (mode: CodeLayoutMode) => void;
    onNewSession: () => void;
    onOpenApps: () => void;
    isGlass?: boolean;
  }) => {
    const styles = useStyles();
    return (
      <div className={mergeClasses(styles.deckHeader, isGlass && styles.glassDeckHeader)}>
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
            options={[
              { value: 'deck', label: 'Deck' },
              { value: 'focus', label: 'Focus' },
            ]}
            onChange={onLayoutMode}
            layoutId="code-layout-toggle"
          />
          <Menu positioning={{ position: 'below', align: 'end' }}>
            <MenuTrigger>
              <Button size="sm" variant="ghost" leftIcon={<Add20Regular style={{ width: 13, height: 13 }} />}>
                New
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={onNewSession}>
                  <Chat20Regular style={{ width: 16, height: 16, marginRight: 6, verticalAlign: 'text-bottom' }} />
                  Agent Session
                </MenuItem>
                <MenuItem onClick={onOpenApps}>
                  <Apps20Regular style={{ width: 16, height: 16, marginRight: 6, verticalAlign: 'text-bottom' }} />
                  Apps
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>
    );
  }
);
CodeDeckHeader.displayName = 'CodeDeckHeader';

const SessionActionButton = forwardRef<
  HTMLButtonElement,
  {
    icon: React.ReactNode;
    label: string;
    isDisabled?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    className?: string;
    'aria-pressed'?: boolean;
    'aria-expanded'?: boolean;
  }
>(({ icon, label, isDisabled, onClick, className, ...rest }, ref) => {
  const styles = useStyles();
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={isDisabled}
      onClick={onClick}
      className={mergeClasses(styles.sessionActionBtn, isDisabled && styles.sessionActionBtnDisabled, className)}
      {...rest}
    >
      {icon}
    </button>
  );
});
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
    dragSurfaceProps,
    ticketId,
    onOpenPanel,
    isGlass,
  }: {
    label: string;
    ticketTitle?: string | null;
    ticketColumnBadge?: React.ReactNode;
    ticketMetaBadge?: React.ReactNode;
    ticketActions?: React.ReactNode;
    actions?: React.ReactNode;
    onClose?: () => void;
    dragHandle?: React.ReactNode;
    dragSurfaceProps?: React.HTMLAttributes<HTMLDivElement>;
    ticketId?: TicketId;
    onOpenPanel?: (panel: TicketPanel) => void;
    isGlass?: boolean;
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
        <div
          className={mergeClasses(styles.sessionHeader, styles.dragSurface, isGlass && styles.glassSessionHeader)}
          {...dragSurfaceProps}
        >
          <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
            {dragHandle}
            <span className={styles.sessionLabel} title={label}>
              {label}
            </span>
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
          <div className={mergeClasses(styles.ticketBanner, isGlass && styles.glassTicketBanner)}>
            <span className={styles.ticketTitle} title={ticketTitle}>
              {ticketTitle}
            </span>
            {(ticketColumnBadge || ticketMetaBadge) && (
              <span className={styles.ticketBadges}>
                {ticketColumnBadge}
                {ticketMetaBadge}
              </span>
            )}
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
    isGlass,
    hasSidecar,
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
    isGlass?: boolean;
    hasSidecar?: boolean;
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
        <div className={mergeClasses(styles.deckColumnBordered, isGlass && styles.glassCard, hasSidecar && styles.cardNoRightMargin)}>
          <CodeSessionHeader
            label={label}
            ticketTitle={ticketTitle}
            ticketColumnBadge={ticketColumnBadge}
            ticketMetaBadge={ticketMetaBadge}
            ticketActions={ticketActions}
            isGlass={isGlass}
            actions={
              <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
                {headerActionsSlot}
                {actions}
                <SessionActionButton
                  icon={
                    isExpanded ? (
                      <ArrowMinimize20Regular style={{ width: 15, height: 15 }} />
                    ) : (
                      <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />
                    )
                  }
                  label={isExpanded ? 'Collapse column' : 'Expand column'}
                  aria-pressed={isExpanded}
                  onClick={() => onToggleExpand(tab.id)}
                  className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
                />
              </div>
            }
            onClose={() => onClose(tab.id)}
            ticketId={tab.ticketId as TicketId | undefined}
            onOpenPanel={tab.ticketId ? setActivePanel : undefined}
            dragSurfaceProps={listeners}
            dragHandle={
              <button
                type="button"
                className={styles.dragHandleA11y}
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${label}`}
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
        <div id={`code-deck-dock-target-${tab.id}`} className={styles.deckDockSlot} />
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
    isExpanded,
    onToggleExpand,
    isGlass,
  }: {
    tab: CodeTab;
    app: CustomAppEntry;
    onClose: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
    isGlass?: boolean;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };
    const styles = useStyles();
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
        className={mergeClasses(styles.deckColumn, isDragging && styles.deckColumnDragging)}
      >
        <div className={mergeClasses(styles.deckColumnBordered, isGlass && styles.glassCard)}>
          <div
            className={mergeClasses(styles.sessionHeader, styles.dragSurface, isGlass && styles.glassSessionHeader)}
            {...listeners}
          >
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
              <button
                type="button"
                className={styles.dragHandleA11y}
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${app.label}`}
              >
                <ReOrderDotsVertical20Regular style={{ width: 16, height: 16 }} />
              </button>
              <span className={styles.sessionLabel} title={app.label}>
                {app.label}
              </span>
            </div>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
              <SessionActionButton
                icon={
                  isExpanded ? (
                    <ArrowMinimize20Regular style={{ width: 15, height: 15 }} />
                  ) : (
                    <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />
                  )
                }
                label={isExpanded ? 'Collapse column' : 'Expand column'}
                aria-pressed={isExpanded}
                onClick={() => onToggleExpand(tab.id)}
                className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
              />
              <SessionActionButton
                icon={<Add20Regular style={{ width: 14, height: 14, transform: 'rotate(45deg)' }} />}
                label={`Close ${app.label}`}
                onClick={() => onClose(tab.id)}
              />
            </div>
          </div>
          <div className={styles.flex1MinH0Relative}>
            <Webview src={app.url} showUnavailable={false} registry={registryProps} />
          </div>
        </div>
        <div className={styles.deckDockSlot} />
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
    isExpanded,
    onToggleExpand,
    isGlass,
  }: {
    tab: CodeTab;
    onClose: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
    isGlass?: boolean;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };
    const styles = useStyles();

    return (
      <div
        ref={setNodeRef}
        style={style}
        className={mergeClasses(styles.deckColumn, isDragging && styles.deckColumnDragging)}
      >
        <div className={mergeClasses(styles.deckColumnBordered, isGlass && styles.glassCard)}>
          <div
            className={mergeClasses(styles.sessionHeader, styles.dragSurface, isGlass && styles.glassSessionHeader)}
            {...listeners}
          >
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
              <button
                type="button"
                className={styles.dragHandleA11y}
                {...attributes}
                {...listeners}
                aria-label="Reorder Browser"
              >
                <ReOrderDotsVertical20Regular style={{ width: 16, height: 16 }} />
              </button>
              <Globe20Regular style={{ width: 14, height: 14, color: tokens.colorNeutralForeground2 }} />
              <span className={styles.sessionLabel} title="Browser">
                Browser
              </span>
            </div>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
              <SessionActionButton
                icon={
                  isExpanded ? (
                    <ArrowMinimize20Regular style={{ width: 15, height: 15 }} />
                  ) : (
                    <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />
                  )
                }
                label={isExpanded ? 'Collapse column' : 'Expand column'}
                aria-pressed={isExpanded}
                onClick={() => onToggleExpand(tab.id)}
                className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
              />
              <SessionActionButton
                icon={<Add20Regular style={{ width: 14, height: 14, transform: 'rotate(45deg)' }} />}
                label="Close Browser"
                onClick={() => onClose(tab.id)}
              />
            </div>
          </div>
          <div className={styles.flex1MinH0Relative}>
            <BrowserView tabsetId={`col:${tab.id}`} isGlass={isGlass} />
          </div>
        </div>
        <div className={styles.deckDockSlot} />
      </div>
    );
  }
);
BrowserColumn.displayName = 'BrowserColumn';

type SidecarBodyProps = {
  app: AppDescriptor;
  originTabId: CodeTabId;
  sandboxUrls: { codeServerUrl?: string; noVncUrl?: string } | undefined;
  terminalCwd?: string;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  isGlass?: boolean;
  hidden: boolean;
};

/**
 * One sidecar app body. Rendered per mounted app with `hidden` toggling
 * `display: none` so the underlying DOM (xterm container, Electron webview,
 * iframe) survives app switches — preserves terminal scrollback, in-flight
 * browser page, loaded code-server session, etc.
 */
const SidecarBody = memo(
  ({ app, originTabId, sandboxUrls, terminalCwd, previewUrl, onPreviewUrlChange, isGlass, hidden }: SidecarBodyProps) => {
    const styles = useStyles();
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
          isGlass={isGlass}
          registryScope="column"
          registryTabId={originTabId}
          src={previewUrl}
          onUrlChange={onPreviewUrlChange}
        />
      );
    } else if (app.kind === 'builtin-terminal') {
      body = <ConsoleStarted tabId={originTabId} cwd={terminalCwd} />;
    } else if (app.kind === 'builtin-code') {
      body = sandboxUrls?.codeServerUrl ? (
        <Webview src={sandboxUrls.codeServerUrl} showUnavailable={false} registry={registryProps} />
      ) : (
        <div className={styles.sidecarUnavailable}>{app.label} is unavailable for this workspace.</div>
      );
    } else if (app.kind === 'builtin-desktop') {
      body = sandboxUrls?.noVncUrl ? (
        <Webview src={sandboxUrls.noVncUrl} showUnavailable={false} registry={registryProps} />
      ) : (
        <div className={styles.sidecarUnavailable}>{app.label} is unavailable for this workspace.</div>
      );
    } else if (app.kind === 'webview') {
      body = app.url ? (
        <Webview src={app.url} showUnavailable={false} registry={registryProps} />
      ) : (
        <div className={styles.sidecarUnavailable}>No URL configured.</div>
      );
    }

    return (
      <div className={mergeClasses(styles.sidecarBodyFill, hidden && styles.sidecarBodyHidden)}>
        {body}
      </div>
    );
  }
);
SidecarBody.displayName = 'SidecarBody';

/**
 * Non-sortable adjacent column that hosts a dock app bound to an origin code
 * tab. Handles register under `tab-<originTabId>:<appId>` so agents scoped to
 * the origin tab see these apps exactly as they did when the dock opened them
 * inline.
 */
const SidecarColumn = memo(
  ({
    originTab,
    app,
    sandboxUrls,
    terminalCwd,
    previewUrl,
    onPreviewUrlChange,
    onClose,
    isGlass,
    isExpanded,
    onToggleExpand,
  }: {
    originTab: CodeTab;
    app: AppDescriptor;
    sandboxUrls: { codeServerUrl?: string; noVncUrl?: string } | undefined;
    terminalCwd?: string;
    previewUrl?: string;
    onPreviewUrlChange?: (url: string) => void;
    onClose: () => void;
    isGlass?: boolean;
    isExpanded: boolean;
    onToggleExpand: () => void;
  }) => {
    const styles = useStyles();

    // Keep every app we've ever activated mounted (hidden when inactive) so
    // its DOM survives sidecar app switches. Without this, switching away
    // from the browser tears down the <webview> and it reloads on return;
    // switching away from the terminal drops the xterm's attached element.
    const [mounted, setMounted] = useState<Map<AppId, AppDescriptor>>(
      () => new Map([[app.id, app]])
    );
    useEffect(() => {
      setMounted((prev) => {
        if (prev.has(app.id)) {
          return prev;
        }
        const next = new Map(prev);
        next.set(app.id, app);
        return next;
      });
    }, [app]);

    return (
      <div className={styles.deckColumn}>
        <div className={mergeClasses(styles.deckColumnBordered, isGlass && styles.glassCard, styles.cardFlattenLeft)}>
          <div className={mergeClasses(styles.sessionHeader, isGlass && styles.glassSessionHeader)}>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
              <AppIcon icon={app.icon} size={14} />
              <span className={styles.sessionLabel} title={app.label}>
                {app.label}
              </span>
            </div>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
              <SessionActionButton
                icon={
                  isExpanded ? (
                    <ArrowMinimize20Regular style={{ width: 15, height: 15 }} />
                  ) : (
                    <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />
                  )
                }
                label={isExpanded ? 'Collapse column' : 'Expand column'}
                aria-pressed={isExpanded}
                onClick={onToggleExpand}
                className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
              />
              <SessionActionButton
                icon={<Subtract20Regular style={{ width: 14, height: 14 }} />}
                label={`Hide ${app.label}`}
                onClick={onClose}
              />
            </div>
          </div>
          <div className={styles.flex1MinH0Relative}>
            {Array.from(mounted.values()).map((mountedApp) => (
              <SidecarBody
                key={mountedApp.id}
                app={mountedApp}
                originTabId={originTab.id}
                sandboxUrls={sandboxUrls}
                terminalCwd={terminalCwd}
                previewUrl={previewUrl}
                onPreviewUrlChange={onPreviewUrlChange}
                isGlass={isGlass}
                hidden={mountedApp.id !== app.id}
              />
            ))}
          </div>
        </div>
        <div className={styles.deckDockSlot} />
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

const AppLauncherGrid = memo(
  ({ apps, onPick, isGlass }: { apps: CustomAppEntry[]; onPick: (appId: string) => void; isGlass?: boolean }) => {
    const styles = useStyles();
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
      <div ref={ref} className={styles.launcherGrid} style={{ ['--launcher-cell-width' as string]: `${cellWidth}px` }}>
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className={mergeClasses(styles.launcherRow, uniform && rowIndex % 2 === 1 && styles.launcherRowOffset)}
          >
            {row.map((app) => (
              <button
                key={app.id}
                type="button"
                className={styles.launcherItem}
                onClick={() => onPick(app.id)}
                title={app.label}
              >
                <span className={mergeClasses(styles.launcherIconDisk, isGlass && styles.launcherIconDiskGlass)}>
                  <AppIcon icon={app.icon} size={34} />
                </span>
                <span className={styles.launcherItemLabel}>{app.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  }
);
AppLauncherGrid.displayName = 'AppLauncherGrid';

const AppLauncherColumn = memo(
  ({
    tab,
    customApps,
    onClose,
    isExpanded,
    onToggleExpand,
    isGlass,
  }: {
    tab: CodeTab;
    customApps: CustomAppEntry[];
    onClose: (id: CodeTabId) => void;
    isExpanded: boolean;
    onToggleExpand: (id: CodeTabId) => void;
    isGlass?: boolean;
  }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
    const style = { transform: CSS.Transform.toString(transform), transition };
    const styles = useStyles();

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
        className={mergeClasses(styles.deckColumn, isDragging && styles.deckColumnDragging)}
      >
        <div className={mergeClasses(styles.deckColumnBordered, isGlass && styles.glassCard)}>
          <div
            className={mergeClasses(styles.sessionHeader, styles.dragSurface, isGlass && styles.glassSessionHeader)}
            {...listeners}
          >
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap2, styles.minW0)}>
              <button
                type="button"
                className={styles.dragHandleA11y}
                {...attributes}
                {...listeners}
                aria-label="Reorder Apps"
              >
                <ReOrderDotsVertical20Regular style={{ width: 16, height: 16 }} />
              </button>
              <span className={styles.sessionLabel} title="Apps">
                Apps
              </span>
            </div>
            <div className={mergeClasses(styles.flexItemsCenter, styles.gap1)}>
              <SessionActionButton
                icon={
                  isExpanded ? (
                    <ArrowMinimize20Regular style={{ width: 15, height: 15 }} />
                  ) : (
                    <ArrowMaximize20Regular style={{ width: 15, height: 15 }} />
                  )
                }
                label={isExpanded ? 'Collapse column' : 'Expand column'}
                aria-pressed={isExpanded}
                onClick={() => onToggleExpand(tab.id)}
                className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
              />
              <SessionActionButton
                icon={<Add20Regular style={{ width: 14, height: 14, transform: 'rotate(45deg)' }} />}
                label="Close Apps"
                onClick={() => onClose(tab.id)}
              />
            </div>
          </div>
          <div className={mergeClasses(styles.launcherBody, isGlass && styles.launcherBodyGlass)}>
            {customApps.length === 0 ? (
              <div className={styles.launcherEmpty}>No apps installed. Add apps in Settings.</div>
            ) : (
              <AppLauncherGrid apps={customApps} onPick={handlePick} isGlass={isGlass} />
            )}
          </div>
        </div>
        <div className={styles.deckDockSlot} />
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
    ticketColumnBadge,
    ticketMetaBadge,
    ticketActions,
    actions,
    onClose,
    isVisible,
    activeApp,
    onActiveAppChange,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    previewUrl,
    onPreviewUrlChange,
    isGlass,
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
    activeApp: AppId;
    onActiveAppChange?: (app: AppId) => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    previewUrl?: string;
    onPreviewUrlChange?: (url: string) => void;
    isGlass?: boolean;
  }) => {
    const styles = useStyles();
    const [activePanel, setActivePanel] = useState<TicketPanel | null>(null);
    const handleClosePanel = useCallback(() => setActivePanel(null), []);

    return (
      <div
        className={mergeClasses(
          styles.sessionPane,
          isGlass && styles.glassSessionPane,
          !isVisible && styles.sessionPaneHidden
        )}
      >
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
          isGlass={isGlass}
        />
        <div className={styles.flex1MinH0Relative}>
          <CodeTabContent
            tab={tab}
            isVisible={isVisible}
            activeApp={activeApp}
            onActiveAppChange={onActiveAppChange}
            uiMinimal={uiMinimal}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
            isGlass={isGlass}
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
  ({
    tab,
    label,
    subLabel,
    isActive,
    onSelect,
    onClose,
  }: {
    tab: CodeTab;
    label: string;
    subLabel?: string | null;
    isActive: boolean;
    onSelect: (id: CodeTabId) => void;
    onClose: (id: CodeTabId) => void;
  }) => {
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
            className={mergeClasses(styles.dragHandle, styles.revealOnHover, 'revealOnHover')}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${label}`}
          >
            <ReOrderDotsVertical20Regular style={{ width: 14, height: 14 }} />
          </button>
          <button type="button" onClick={() => onSelect(tab.id)} className={styles.focusListItemContent}>
            <div className={styles.focusListItemInner}>
              <span className={styles.focusListItemLabel} title={label}>
                {label}
              </span>
              {subLabel && (
                <span className={styles.focusListItemSub} title={subLabel}>
                  {subLabel}
                </span>
              )}
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
  const deckBackground = store.codeDeckBackground ?? null;
  const [activeApps, setActiveApps] = useState<Record<CodeTabId, AppId>>({});
  // Remembers the last non-'chat' app a tab's sidecar displayed. Lets us keep
  // `SidecarColumn` mounted (just hidden) when the user minimizes, so state
  // like terminal scrollback or an open browser tab survives hide → re-show.
  const [lastSidecarAppByTab, setLastSidecarAppByTab] = useState<Record<CodeTabId, AppId>>({});
  const [previewUrls, setPreviewUrls] = useState<Record<CodeTabId, string>>({});
  const [expandedTabIds, setExpandedTabIds] = useState<ReadonlySet<CodeTabId>>(() => new Set());
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
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
  }, []);

  const addingFirstTab = useRef(false);
  useEffect(() => {
    if (tabs.length === 0 && !addingFirstTab.current) {
      addingFirstTab.current = true;
      codeApi.addTab().finally(() => {
        addingFirstTab.current = false;
      });
    }
  }, [tabs.length]);

  useEffect(() => {
    const firstTab = tabs[0];
    if (!activeTabId && firstTab) {
      codeApi.setActiveTab(firstTab.id);
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    setExpandedTabIds((current) => {
      const validIds = new Set(tabs.map((t) => t.id));
      let changed = false;
      const next = new Set<CodeTabId>();
      for (const id of current) {
        // Sidecar-scoped keys (`sidecar:<tabId>`) are valid while their origin tab exists.
        const originId = id.startsWith('sidecar:') ? id.slice('sidecar:'.length) : id;
        if (validIds.has(originId)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
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
      setActiveApps((prev) => ({ ...prev, [targetTabId]: 'browser' }));
      clearPreviewRequest();
    });
    return unsubscribe;
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const projectMap = useMemo(() => {
    const map = new Map<string, { label: string; workspaceDir: string | undefined }>();
    for (const p of store.projects) {
      map.set(p.id, { label: p.label, workspaceDir: p.source?.kind === 'local' ? p.source.workspaceDir : undefined });
    }
    return map;
  }, [store.projects]);

  const customApps = useMemo(() => [SYNTHETIC_BROWSER_APP, ...(store.customApps ?? [])], [store.customApps]);
  const appRegistry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);

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
        return 'New Session';
      }
      return projectMap.get(tab.projectId)?.label ?? 'Unknown';
    },
    [projectMap, customApps]
  );

  const resolveTicketTitle = useCallback((tab: CodeTab) => tab.ticketTitle ?? null, []);

  const resolveSubLabel = useCallback(
    (tab: CodeTab) => {
      if (!tab.projectId) {
        return null;
      }
      const workspaceDir = projectMap.get(tab.projectId)?.workspaceDir;
      if (!workspaceDir) {
        return null;
      }
      const segments = workspaceDir.split('/').filter(Boolean);
      return segments.slice(-2).join('/');
    },
    [projectMap]
  );

  const handleLayoutMode = useCallback((mode: CodeLayoutMode) => {
    codeApi.setLayoutMode(mode);
  }, []);

  const handleNewSession = useCallback(() => {
    codeApi.addTab();
  }, []);

  const handleOpenApps = useCallback(() => {
    void codeApi.addAppTab(APP_LAUNCHER_ID);
  }, []);

  const getColumnWidth = useCallback(
    (tabId: CodeTabId) => {
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
    [expandedTabIds, viewportWidth]
  );

  const handleSelect = useCallback((id: CodeTabId) => {
    codeApi.setActiveTab(id);
  }, []);

  const handleToggleExpand = useCallback((id: CodeTabId) => {
    setExpandedTabIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClose = useCallback((id: CodeTabId) => {
    setActiveApps((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setLastSidecarAppByTab((current) => {
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
    codeApi.removeTab(id);
  }, []);

  const handleActiveAppChange = useCallback((tabId: CodeTabId, app: AppId) => {
    setActiveApps((prev) => {
      const current = prev[tabId] ?? 'chat';
      // Clicking the already-active app closes the sidecar.
      const next = current === app ? 'chat' : app;
      return { ...prev, [tabId]: next };
    });
    if (app !== 'chat') {
      setLastSidecarAppByTab((prev) => (prev[tabId] === app ? prev : { ...prev, [tabId]: app }));
    }
  }, []);

  const handlePreviewUrlChange = useCallback((tabId: CodeTabId, url: string) => {
    setPreviewUrls((prev) => ({ ...prev, [tabId]: url }));
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

  const handleNewTabSession = useCallback((tab: CodeTab) => {
    codeApi.setTabSessionId(tab.id, uuidv4());
  }, []);

  const renderSessionActions = useCallback(
    (tab: CodeTab) => (
      <SessionActionButton
        icon={<Add20Regular style={{ width: 13, height: 13 }} />}
        label="New session"
        onClick={() => handleNewTabSession(tab)}
        className={mergeClasses(styles.revealOnHover, 'revealOnHover')}
      />
    ),
    [handleNewTabSession, styles.revealOnHover]
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
    return (
      <>
        <TicketBannerActions ticketId={tab.ticketId} />
        <TicketResolutionBadge ticketId={tab.ticketId} />
      </>
    );
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
      <CodeDeckHeader
        layoutMode={layoutMode}
        onLayoutMode={handleLayoutMode}
        onNewSession={handleNewSession}
        onOpenApps={handleOpenApps}
        isGlass={!!deckBackground}
      />
      {layoutMode === 'deck' && (
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div ref={deckScrollRef} className={styles.deckScroll}>
              <div className={styles.deckInner}>
                {tabs.map((tab) => {
                  const isLauncher = tab.customAppId === APP_LAUNCHER_ID;
                  const appEntry =
                    tab.customAppId && !isLauncher ? customApps.find((a) => a.id === tab.customAppId) : undefined;
                  const activeAppId = activeApps[tab.id] ?? 'chat';
                  // The currently-displayed sidecar app (if any).
                  const sidecarApp =
                    !isLauncher && !appEntry && activeAppId !== 'chat'
                      ? appRegistry.find((a) => a.id === activeAppId)
                      : undefined;
                  // The sidecar app to keep MOUNTED (may be hidden). Preserves
                  // state across minimize/restore — hidden when activeApp is
                  // 'chat' but the tab has opened a sidecar before.
                  const mountedSidecarApp =
                    sidecarApp ??
                    (!isLauncher && !appEntry && lastSidecarAppByTab[tab.id]
                      ? appRegistry.find((a) => a.id === lastSidecarAppByTab[tab.id])
                      : undefined);
                  const sidecarHidden = !sidecarApp;
                  const tabStatus = statuses[tab.id];
                  const tabSandboxUrls =
                    tabStatus && (tabStatus.type === 'running' || tabStatus.type === 'connecting')
                      ? tabStatus.data
                      : undefined;
                  const tabTerminalCwd =
                    tab.workspaceDir ??
                    (tab.projectId ? projectMap.get(tab.projectId)?.workspaceDir : undefined);
                  return (
                    <Fragment key={tab.id}>
                      <div style={{ width: getColumnWidth(tab.id) }} className={styles.deckColumnWrap}>
                        {isLauncher ? (
                          <AppLauncherColumn
                            tab={tab}
                            customApps={customApps}
                            onClose={handleClose}
                            isExpanded={expandedTabIds.has(tab.id)}
                            onToggleExpand={handleToggleExpand}
                            isGlass={!!deckBackground}
                          />
                        ) : appEntry?.id === BROWSER_APP_ID ? (
                          <BrowserColumn
                            tab={tab}
                            onClose={handleClose}
                            isExpanded={expandedTabIds.has(tab.id)}
                            onToggleExpand={handleToggleExpand}
                            isGlass={!!deckBackground}
                          />
                        ) : appEntry ? (
                          <AppColumn
                            tab={tab}
                            app={appEntry}
                            onClose={handleClose}
                            isExpanded={expandedTabIds.has(tab.id)}
                            onToggleExpand={handleToggleExpand}
                            isGlass={!!deckBackground}
                          />
                        ) : (
                          <DeckColumn
                            tab={tab}
                            label={resolveLabel(tab)}
                            ticketTitle={resolveTicketTitle(tab)}
                            ticketColumnBadge={renderTicketColumnBadge(tab)}
                            ticketMetaBadge={renderTicketMetaBadge(tab)}
                            ticketActions={renderTicketBannerActions(tab)}
                            actions={renderSessionActions(tab)}
                            onClose={handleClose}
                            isExpanded={expandedTabIds.has(tab.id)}
                            onToggleExpand={handleToggleExpand}
                            headerActionsSlot={<div id={`code-deck-header-actions-${tab.id}`} />}
                            isGlass={!!deckBackground}
                            hasSidecar={!!sidecarApp}
                          >
                            <CodeTabContent
                              tab={tab}
                              isVisible
                              activeApp={activeAppId}
                              onActiveAppChange={(app) => handleActiveAppChange(tab.id, app)}
                              uiMinimal
                              headerActionsTargetId={`code-deck-header-actions-${tab.id}`}
                              headerActionsCompact
                              previewUrl={previewUrls[tab.id]}
                              onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
                              dockTargetId={`code-deck-dock-target-${tab.id}`}
                              isGlass={!!deckBackground}
                              sidecarMode
                            />
                          </DeckColumn>
                        )}
                      </div>
                      {mountedSidecarApp && (
                        <div
                          style={{
                            width: getColumnWidth(`sidecar:${tab.id}`),
                            ...(sidecarHidden ? { display: 'none' } : {}),
                          }}
                          className={styles.deckColumnWrap}
                        >
                          <SidecarColumn
                            originTab={tab}
                            app={mountedSidecarApp}
                            sandboxUrls={tabSandboxUrls}
                            terminalCwd={tabTerminalCwd}
                            previewUrl={previewUrls[tab.id]}
                            onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
                            onClose={() => handleActiveAppChange(tab.id, 'chat')}
                            isGlass={!!deckBackground}
                            isExpanded={expandedTabIds.has(`sidecar:${tab.id}`)}
                            onToggleExpand={() => handleToggleExpand(`sidecar:${tab.id}`)}
                          />
                        </div>
                      )}
                    </Fragment>
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
              <div className={mergeClasses(styles.mobileTabBar, !!deckBackground && styles.glassMobileTabBar)}>
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
                        tab.id === activeTab?.id ? styles.mobileTabChipActive : styles.mobileTabChipInactive,
                        !!deckBackground &&
                          (tab.id === activeTab?.id
                            ? styles.glassMobileTabChipActive
                            : styles.glassMobileTabChipInactive)
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
              <div className={mergeClasses(styles.focusSidebar, !!deckBackground && styles.glassFocusSidebar)}>
                <div
                  className={mergeClasses(
                    styles.focusSidebarHeader,
                    !!deckBackground && styles.glassFocusSidebarHeader
                  )}
                >
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
                {tabs.map((tab) => {
                  const isLauncher = tab.customAppId === APP_LAUNCHER_ID;
                  const appEntry =
                    tab.customAppId && !isLauncher ? customApps.find((a) => a.id === tab.customAppId) : undefined;
                  if (isLauncher) {
                    return (
                      <div
                        key={tab.id}
                        style={{
                          width: '100%',
                          height: '100%',
                          display: tab.id === activeTab?.id ? 'flex' : 'none',
                          flexDirection: 'column',
                        }}
                      >
                        <div
                          className={mergeClasses(styles.launcherBody, !!deckBackground && styles.launcherBodyGlass)}
                        >
                          {customApps.length === 0 ? (
                            <div className={styles.launcherEmpty}>No apps installed. Add apps in Settings.</div>
                          ) : (
                            <AppLauncherGrid
                              apps={customApps}
                              onPick={(appId) => codeApi.setTabAppId(tab.id, appId)}
                              isGlass={!!deckBackground}
                            />
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (appEntry?.id === BROWSER_APP_ID) {
                    return (
                      <div
                        key={tab.id}
                        style={{
                          width: '100%',
                          height: '100%',
                          display: tab.id === activeTab?.id ? 'flex' : 'none',
                          flexDirection: 'column',
                        }}
                      >
                        <BrowserView tabsetId={`col:${tab.id}`} isGlass={!!deckBackground} />
                      </div>
                    );
                  }
                  if (appEntry) {
                    const scope: AppHandleScope = appEntry.columnScoped ? 'column' : 'global';
                    return (
                      <div
                        key={tab.id}
                        style={{ width: '100%', height: '100%', display: tab.id === activeTab?.id ? 'block' : 'none' }}
                      >
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
                      ticketColumnBadge={renderTicketColumnBadge(tab)}
                      ticketMetaBadge={renderTicketMetaBadge(tab)}
                      ticketActions={renderTicketBannerActions(tab)}
                      actions={renderSessionActions(tab)}
                      onClose={handleClose}
                      isVisible={tab.id === activeTab?.id}
                      activeApp={activeApps[tab.id] ?? 'chat'}
                      onActiveAppChange={(app) => handleActiveAppChange(tab.id, app)}
                      uiMinimal
                      headerActionsTargetId={undefined}
                      headerActionsCompact
                      previewUrl={previewUrls[tab.id]}
                      onPreviewUrlChange={(url) => handlePreviewUrlChange(tab.id, url)}
                      isGlass={!!deckBackground}
                    />
                  );
                })}
              </div>
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
});
CodeDeck.displayName = 'CodeDeck';
