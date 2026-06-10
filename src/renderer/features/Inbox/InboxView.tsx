import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, ArchiveRegular, MailInbox20Regular, TimerRegular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { IconButton, type SelectTabData, Tab, TabList } from '@/renderer/ds';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { InboxItem, InboxItemId } from '@/shared/types';

import { InboxItemDetail } from './InboxItemDetail';
import { $activeInbox, $inboxItems, $laterInbox, $promotedInbox } from './state';

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
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    flexShrink: 0,
  },
  headerIcon: { color: tokens.colorBrandForeground1 },
  title: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  spacer: { flex: '1 1 0' },
  tabs: { flexShrink: 0 },
  mobileFilters: {
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
  },
  mobileTabs: {
    width: '100%',
  },
  filterTab: {
    flex: '1 1 0',
    justifyContent: 'center',
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: 'transparent',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
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
    fontWeight: tokens.fontWeightSemibold,
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
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    marginTop: '2px',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 6px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  laterBadge: {
    backgroundColor: tokens.colorPaletteYellowBackground2,
    color: tokens.colorPaletteYellowForeground2,
  },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type InboxTab = 'active' | 'later' | 'archive';

export const InboxView = memo(
  ({ selectedItemId, hideChrome = false }: { selectedItemId?: InboxItemId; hideChrome?: boolean }) => {
    const styles = useStyles();
    const active = useStore($activeInbox);
    const later = useStore($laterInbox);
    const promoted = useStore($promotedInbox);
    const itemsById = useStore($inboxItems);

    const [tab, setTab] = useState<InboxTab>('active');
    const [selectedId, setSelectedId] = useState<InboxItemId | null>(null);

    // Resolve the selected item every render so edits made through IPC flow
    // back in via store:changed without having to reset local state.
    const selectedItem = useMemo(() => (selectedId ? (itemsById[selectedId] ?? null) : null), [selectedId, itemsById]);

    const visible = tab === 'active' ? active : tab === 'later' ? later : promoted;

    useEffect(() => {
      if (selectedItemId === undefined) {
        return;
      }

      const item = itemsById[selectedItemId] ?? null;
      setSelectedId(item?.id ?? null);
      if (!item) {
        return;
      }
      if (item.promotedTo) {
        setTab('archive');
        return;
      }
      if (item.status === 'later') {
        setTab('later');
        return;
      }
      setTab('active');
    }, [selectedItemId, itemsById]);

    useEffect(() => {
      if (!selectedItem || selectedItemId !== undefined) {
        return;
      }
      if (selectedItem.promotedTo) {
        setTab('archive');
      } else if (selectedItem.status === 'later') {
        setTab('later');
      } else {
        setTab('active');
      }
    }, [selectedItem, selectedItemId]);

    const handleBack = useCallback(() => {
      if (selectedItemId) {
        ticketApi.goToInbox();
        return;
      }
      setSelectedId(null);
    }, [selectedItemId]);

    const handleAdd = useCallback(() => {
      $quickCaptureOpen.set(true);
    }, []);
    const handleTabSelect = useCallback((_event: unknown, data: SelectTabData) => {
      setTab(data.value as InboxTab);
    }, []);
    const handleOpenItem = useCallback((id: InboxItemId) => setSelectedId(id), []);

    // Detail view takes over the panel when an item is selected.
    //
    // Keying on `selectedItem.id` forces a full remount when the user navigates
    // to a different item. Without the key, InboxItemDetail held per-item edit
    // buffers in component-local state tied to a prop, so switching items
    // either (a) silently dropped unsaved edits, or (b) wrote the previous
    // item's draft onto the newly-selected item via a stale `onBlur` closure.
    // Remount gives every item a fresh component lifecycle and makes the
    // buffers structurally incapable of crossing item boundaries.
    if (selectedItem) {
      return <InboxItemDetail key={selectedItem.id} item={selectedItem} onBack={handleBack} hideHeader={hideChrome} />;
    }

    return (
      <div className={styles.root}>
        {!hideChrome && (
          <div className={styles.header}>
            <MailInbox20Regular className={styles.headerIcon} />
            <span className={styles.title}>Inbox</span>
            <div className={styles.spacer} />
            <IconButton aria-label="Add item" icon={<Add20Regular />} size="sm" onClick={handleAdd} />
            <TabList selectedValue={tab} onTabSelect={handleTabSelect} size="small" className={styles.tabs}>
              <Tab value="active">Inbox {active.length}</Tab>
              <Tab value="later">Later {later.length}</Tab>
              <Tab value="archive">Archive {promoted.length}</Tab>
            </TabList>
          </div>
        )}

        {hideChrome && (
          <div className={styles.mobileFilters}>
            <TabList
              selectedValue={tab}
              onTabSelect={handleTabSelect}
              size="small"
              appearance="subtle"
              className={styles.mobileTabs}
            >
              <Tab value="active" className={styles.filterTab}>
                Inbox {active.length}
              </Tab>
              <Tab value="later" className={styles.filterTab}>
                Later {later.length}
              </Tab>
              <Tab value="archive" className={styles.filterTab}>
                Archive {promoted.length}
              </Tab>
            </TabList>
          </div>
        )}

        <div className={styles.body}>
          {visible.length === 0 ? (
            <div className={styles.empty}>
              {tab === 'active'
                ? 'Your inbox is empty. Nice work.'
                : tab === 'later'
                  ? 'Nothing parked for later.'
                  : 'No promoted items yet.'}
            </div>
          ) : (
            visible.map((item) => <InboxRow key={item.id} item={item} styles={styles} onOpen={handleOpenItem} />)
          )}
        </div>
      </div>
    );
  }
);
InboxView.displayName = 'InboxView';

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type InboxRowProps = {
  item: InboxItem;
  styles: ReturnType<typeof useStyles>;
  onOpen: (id: InboxItemId) => void;
};

const InboxRow = memo(({ item, styles, onOpen }: InboxRowProps) => {
  const handleOpen = useCallback(() => onOpen(item.id), [item.id, onOpen]);

  return (
    <button type="button" className={styles.row} onClick={handleOpen}>
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{item.title}</span>
        {item.note && <span className={styles.rowNote}>{item.note}</span>}
        <div className={styles.rowMeta}>
          {item.status === 'later' && (
            <span className={`${styles.badge} ${styles.laterBadge}`}>
              <TimerRegular style={{ width: 12, height: 12 }} /> Later
            </span>
          )}
          {item.promotedTo && (
            <span className={styles.badge}>
              <ArchiveRegular style={{ width: 12, height: 12 }} /> Promoted to {item.promotedTo.kind}
            </span>
          )}
        </div>
      </div>
    </button>
  );
});
InboxRow.displayName = 'InboxRow';
