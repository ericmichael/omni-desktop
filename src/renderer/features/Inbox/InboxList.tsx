import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight20Regular, Add20Regular, Delete20Filled } from '@fluentui/react-icons';

import { Badge, cn, FAB, IconButton } from '@/renderer/ds';
import { daysRemaining } from '@/lib/inbox-expiry';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, InboxItemId, InboxItemStatus } from '@/shared/types';

import { $inboxItems, $iceboxItems, inboxApi, openQuickCapture } from './state';

const useStyles = makeStyles({
  root: { position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '10px',
    paddingBottom: '10px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  headerRow: {
    display: 'none',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    '@media (min-width: 640px)': { display: 'flex' },
  },
  headerTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  spacer: { flex: '1 1 0' },
  filterRow: { display: 'flex', alignItems: 'center', gap: '6px', overflowX: 'auto' },
  filterChip: {
    flexShrink: 0,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '4px',
    paddingBottom: '4px',
    borderRadius: '9999px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    border: 'none',
    cursor: 'pointer',
  },
  filterActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1 },
  filterInactive: { backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2, ':hover': { color: tokens.colorNeutralForeground1 } },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ':focus': { outline: 'none' },
    '@media (min-width: 640px)': { paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM },
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    height: '100%',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  emptyTitle: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300 },
  emptyHintDesktop: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, display: 'none', '@media (min-width: 640px)': { display: 'block' } },
  emptyHintMobile: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, '@media (min-width: 640px)': { display: 'none' } },
  cardList: { display: 'flex', flexDirection: 'column', gap: '2px' },
  kbdRow: {
    display: 'none',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalM,
    rowGap: '4px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { display: 'flex' },
  },
  kbd: {
    paddingLeft: '4px',
    paddingRight: '4px',
    paddingTop: '2px',
    paddingBottom: '2px',
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    fontSize: tokens.fontSizeBase200,
  },
  iceboxLink: {
    flexShrink: 0,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '10px',
    paddingBottom: '10px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color',
    transitionDuration: '150ms',
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  mobileHidden: { '@media (min-width: 640px)': { display: 'none' } },
  inboxCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '14px',
    paddingBottom: '14px',
    textAlign: 'left',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusXLarge,
    border: 'none',
    backgroundColor: 'transparent',
  },
  cardSelected: { backgroundColor: tokens.colorBrandBackground2 },
  cardFocused: { backgroundColor: tokens.colorSubtleBackgroundHover },
  cardDefault: { ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover } },
  statusDot: { width: '10px', height: '10px', borderRadius: '9999px', flexShrink: 0 },
  cardContent: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  cardTitleRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  cardTitle: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cardMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  cardActions: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
  deleteBtn: { opacity: 0.7, transitionProperty: 'opacity', transitionDuration: '150ms', '@media (min-width: 640px)': { opacity: 0 } },
  chevron: { color: tokens.colorNeutralForeground2, opacity: 0.4, display: 'none', '@media (min-width: 640px)': { display: 'block' } },
});

const STATUS_DOT: Record<InboxItemStatus, string> = {
  open: 'bg-blue-400',
  done: 'bg-green-400',
  deferred: 'bg-fg-muted/50',
  iceboxed: 'bg-fg-muted/30',
};

const STATUS_LABELS: Record<InboxItemStatus, string> = {
  open: 'Open',
  done: 'Done',
  deferred: 'Deferred',
  iceboxed: 'Iceboxed',
};

type InboxFilter = 'all' | 'open' | 'done';

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
];

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

    const styles = useStyles();
    return (
      <button
        ref={ref}
        onClick={handleClick}
        className={mergeClasses(
          styles.inboxCard,
          isSelected ? styles.cardSelected : isFocused ? styles.cardFocused : styles.cardDefault
        )}
      >
        {/* Leading status dot */}
        <span className={cn(styles.statusDot, STATUS_DOT[item.status])} title={STATUS_LABELS[item.status]} />

        {/* Content */}
        <div className={styles.cardContent}>
          <div className={styles.cardTitleRow}>
            <span className={styles.cardTitle}>{item.title}</span>
          </div>
          <div className={styles.cardMeta}>
            <span>{timeAgo(item.createdAt)}</span>
            {item.status === 'open' && (() => {
              const days = daysRemaining(item, Date.now());
              return (
                <>
                  <span className="text-fg-muted/30">&middot;</span>
                  <span className={cn(days <= 1 ? 'text-amber-400' : 'text-fg-subtle')}>
                    {days <= 0 ? 'expiring' : `${days}d left`}
                  </span>
                </>
              );
            })()}
            {item.status === 'open' && (
              <>
                <span className="text-fg-muted/30">&middot;</span>
                {item.shaping ? (
                  <span className="text-green-400">Shaped</span>
                ) : (
                  <span className="text-fg-muted">Needs shaping</span>
                )}
              </>
            )}
            {project && (
              <>
                <span className="text-fg-muted/30">&middot;</span>
                <span className="text-purple-400 truncate">{project.label}</span>
              </>
            )}
          </div>
        </div>

        {/* Trailing actions */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className={styles.cardActions} onClick={(e) => e.stopPropagation()}>
          <IconButton
            aria-label="Delete"
            icon={<Delete20Filled style={{ width: 12, height: 12 }} />}
            size="sm"
            onClick={handleDelete}
            className={styles.deleteBtn}
          />
          <ChevronRight20Regular style={{ width: 12, height: 12 }} className={styles.chevron} />
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
    onShowIcebox,
  }: {
    selectedId: InboxItemId | null;
    onSelect: (id: InboxItemId | null) => void;
    onShowIcebox?: () => void;
  }) => {
    const itemsMap = useStore($inboxItems);
    const iceboxMap = useStore($iceboxItems);
    const [filter, setFilter] = useState<InboxFilter>('all');
    const [focusIndex, setFocusIndex] = useState(-1);
    const listRef = useRef<HTMLDivElement>(null);

    const items = useMemo(() => {
      let list = Object.values(itemsMap).filter((i) => i.status !== 'iceboxed');
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

    const styles = useStyles();
    return (
      <div className={styles.root}>
        {/* Header — desktop: title + select, mobile: just filter chips */}
        <div className={styles.header}>
          {/* Desktop title row */}
          <div className={styles.headerRow}>
            <span className={styles.headerTitle}>Inbox</span>
            {openCount > 0 && (
              <Badge color="blue">{openCount}</Badge>
            )}
            <div className={styles.spacer} />
            <IconButton aria-label="New item" icon={<Add20Regular />} size="sm" onClick={openQuickCapture} />
          </div>

          {/* Filter chips */}
          <div className={styles.filterRow}>
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={mergeClasses(
                  styles.filterChip,
                  filter === f.value ? styles.filterActive : styles.filterInactive
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div
          ref={listRef}
          className={styles.list}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {items.length === 0 ? (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>Inbox is empty</p>
              <p className={styles.emptyHintDesktop}>
                <kbd className={styles.kbd}>Ctrl+I</kbd> to capture from anywhere
              </p>
              <p className={styles.emptyHintMobile}>Tap + to add an item</p>
            </div>
          ) : (
            <>
              <div className={styles.cardList}>
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
              </div>
              <div className={styles.kbdRow}>
                <span><kbd className={styles.kbd}>j</kbd>/<kbd className={styles.kbd}>k</kbd> navigate</span>
                <span><kbd className={styles.kbd}>Enter</kbd> open</span>
                <span><kbd className={styles.kbd}>x</kbd> done</span>
                <span><kbd className={styles.kbd}>Del</kbd> remove</span>
              </div>
            </>
          )}
        </div>

        {/* Icebox link */}
        {onShowIcebox && (() => {
          const iceboxCount = Object.keys(iceboxMap).length;
          if (iceboxCount === 0) return null;
          return (
            <button
              onClick={onShowIcebox}
              className={styles.iceboxLink}
            >
              View icebox ({iceboxCount} item{iceboxCount !== 1 ? 's' : ''})
            </button>
          );
        })()}

        <FAB icon={<Add20Regular style={{ width: 22, height: 22 }} />} onClick={openQuickCapture} aria-label="New item" className={styles.mobileHidden} />
      </div>
    );
  }
);
InboxList.displayName = 'InboxList';
