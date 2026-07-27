import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowCounterclockwise20Regular,
  Delete20Regular,
  MoreHorizontal20Regular,
  TimerRegular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  type SelectTabData,
  Tab,
  TabList,
} from '@/renderer/ds';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import type { InboxItem, InboxItemId } from '@/shared/types';

import { InboxItemDetail } from './InboxItemDetail';
import { $activeInbox, $inboxItems, $inboxView, $laterInbox, $promotedInbox, inboxApi } from './state';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  },
  tabRow: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  tabRowSpacer: {
    flex: '1 1 0',
  },
  tabCount: {
    marginLeft: '6px',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '8px',
    paddingBottom: '8px',
    backgroundColor: 'transparent',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
    '&:hover .inbox-row-menu': { opacity: 1 },
    '&:focus-within .inbox-row-menu': { opacity: 1 },
  },
  rowMenu: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  rowMenuOpen: {
    opacity: 1,
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  rowMain: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  rowTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowNote: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

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
  const styles = useStyles();
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
  const handleTabSelect = useCallback((_event: unknown, data: SelectTabData) => {
    setTab(data.value as InboxTab);
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
    <div className={styles.root}>
      <div className={styles.tabRow}>
        <TabList selectedValue={tab} onTabSelect={handleTabSelect} size="small" appearance="subtle">
          <Tab value="active">
            Inbox
            {active.length > 0 && <span className={styles.tabCount}>{active.length}</span>}
          </Tab>
          <Tab value="later">
            Later
            {later.length > 0 && <span className={styles.tabCount}>{later.length}</span>}
          </Tab>
          <Tab value="archive">Archive</Tab>
        </TabList>
        <div className={styles.tabRowSpacer} />
        <IconButton aria-label="Add item" icon={<Add20Regular />} size="sm" onClick={handleAdd} />
      </div>

      <div className={styles.body}>
        {visible.length === 0 ? (
          <EmptyState
            title={EMPTY_COPY[tab].title}
            description={EMPTY_COPY[tab].description}
            action={
              tab === 'active' ? (
                <Button size="sm" leftIcon={<Add20Regular />} onClick={handleAdd}>
                  Add item
                </Button>
              ) : undefined
            }
          />
        ) : (
          visible.map((item) => <InboxRow key={item.id} item={item} styles={styles} onOpen={handleOpenItem} />)
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
  styles: ReturnType<typeof useStyles>;
  onOpen: (id: InboxItemId) => void;
};

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

const InboxRow = memo(({ item, styles, onOpen }: InboxRowProps) => {
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
  const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => setMenuOpen(data.open), []);
  const handleDefer = useCallback(() => void inboxApi.defer(item.id), [item.id]);
  const handleReactivate = useCallback(() => void inboxApi.reactivate(item.id), [item.id]);
  const handleDrop = useCallback(() => void inboxApi.remove(item.id), [item.id]);

  return (
    // div+role rather than <button>: the row hosts the "…" menu button, and
    // nesting buttons inside a button is invalid markup.
    <div role="button" tabIndex={0} className={styles.row} onClick={handleOpen} onKeyDown={handleKeyDown}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{item.title}</span>
        {item.note && <span className={styles.rowNote}>{item.note}</span>}
      </div>
      <span
        role="presentation"
        className={mergeClasses(styles.rowMenu, 'inbox-row-menu', menuOpen && styles.rowMenuOpen)}
        onClick={stopPropagation}
      >
        <Menu open={menuOpen} onOpenChange={handleMenuOpenChange} positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger disableButtonEnhancement>
            <IconButton aria-label="Item actions" icon={<MoreHorizontal20Regular />} size="sm" />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {!item.promotedTo &&
                (item.status === 'later' ? (
                  <MenuItem icon={<ArrowCounterclockwise20Regular />} onClick={handleReactivate}>
                    Reactivate
                  </MenuItem>
                ) : (
                  <MenuItem icon={<TimerRegular />} onClick={handleDefer}>
                    Defer to later
                  </MenuItem>
                ))}
              <MenuItem icon={<Delete20Regular />} onClick={handleDrop} className={styles.dangerMenuItem}>
                Drop
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </span>
    </div>
  );
});
InboxRow.displayName = 'InboxRow';
