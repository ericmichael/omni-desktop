import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { Open20Regular } from '@fluentui/react-icons';

import { Badge, Button, cn, ConfirmDialog, SectionLabel, Select, Textarea, TopAppBar } from '@/renderer/ds';
import { daysRemaining } from '@/lib/inbox-expiry';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId, InboxItemStatus, ShapingData } from '@/shared/types';

import { APPETITE_COLORS, APPETITE_DESCRIPTIONS, APPETITE_LABELS } from './shaping-constants';
import { ShapingForm } from './ShapingForm';
import { $inboxItems, inboxApi } from './state';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  notFound: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' },
  notFoundText: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300 },
  headerDate: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, display: 'none', '@media (min-width: 640px)': { display: 'inline' } },
  body: { flex: '1 1 0', minHeight: 0, overflowY: 'auto' },
  bodyInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    maxWidth: '672px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    '@media (min-width: 640px)': {
      paddingLeft: tokens.spacingHorizontalXXL,
      paddingRight: tokens.spacingHorizontalXXL,
      paddingTop: tokens.spacingVerticalXL,
      paddingBottom: tokens.spacingVerticalXL,
    },
  },
  expiryBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusXLarge,
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  expiryUrgent: { backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24' },
  expiryNormal: { backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground3 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    borderRadius: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingHorizontalL,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  cardAccent: { ...shorthands.borderColor('rgba(59, 130, 246, 0.2)') },
  inputClass: {
    width: '100%',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'border-color',
    transitionDuration: '150ms',
    ':focus': { outline: 'none', ...shorthands.borderColor(tokens.colorBrandStroke1) },
    '::placeholder': { color: tokens.colorNeutralForeground2, opacity: 0.5 },
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase300 },
  },
  saveRow: { display: 'flex', justifyContent: 'flex-end' },
  shapedContent: { display: 'flex', flexDirection: 'column', gap: '10px' },
  shapedLabel: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightMedium, color: tokens.colorNeutralForeground2 },
  shapedValue: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, marginTop: '2px' },
  shapedBadge: { marginTop: '2px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  statusChip: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
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
  statusActive: { backgroundColor: 'rgba(96, 165, 250, 0.2)', color: 'rgb(96, 165, 250)' },
  statusInactive: { backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2, ':hover': { color: tokens.colorNeutralForeground1 } },
  statusDot: { width: '8px', height: '8px', borderRadius: '9999px' },
  actionsRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalS },
  deleteBtn: { width: '100%', justifyContent: 'center', '@media (min-width: 640px)': { width: 'auto' } },
  convertBtn: { width: '100%', justifyContent: 'center', '@media (min-width: 640px)': { width: 'auto' } },
  convertIcon: { marginRight: '4px' },
});

const STATUS_OPTIONS: { value: InboxItemStatus; label: string; dot: string }[] = [
  { value: 'open', label: 'Open', dot: 'bg-blue-400' },
  { value: 'done', label: 'Done', dot: 'bg-green-400' },
];

export const InboxDetail = memo(
  ({ itemId, onBack }: { itemId: InboxItemId; onBack: () => void }) => {
    const itemsMap = useStore($inboxItems);
    const store = useStore(persistedStoreApi.$atom);
    const item = itemsMap[itemId];

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dirty, setDirty] = useState(false);
    const [converting, setConverting] = useState(false);
    const [convertProjectId, setConvertProjectId] = useState('');

    // Sync local state when item changes externally
    useEffect(() => {
      if (!item) return;
      setTitle(item.title);
      setDescription(item.description ?? '');
      setDirty(false);
      // Pre-select project if item has one, or default to first project
      if (item.projectId) {
        setConvertProjectId(item.projectId);
      } else if (store.projects.length > 0 && !convertProjectId) {
        setConvertProjectId(store.projects[0]!.id);
      }
    }, [item?.id, item?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setTitle(e.target.value);
      setDirty(true);
    }, []);

    const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDescription(e.target.value);
      setDirty(true);
    }, []);

    const handleSave = useCallback(async () => {
      if (!title.trim()) return;
      await inboxApi.updateItem(itemId, {
        title: title.trim(),
        description: description.trim() || undefined,
      });
      setDirty(false);
    }, [itemId, title, description]);

    const handleStatusChange = useCallback(
      (status: InboxItemStatus) => {
        void inboxApi.updateItem(itemId, { status });
      },
      [itemId]
    );

    const handleShapeSave = useCallback(
      (shaping: ShapingData) => {
        void inboxApi.shapeItem(itemId, shaping);
      },
      [itemId]
    );

    const handleConvertToTicket = useCallback(async () => {
      if (!convertProjectId) return;
      setConverting(true);
      try {
        await inboxApi.convertToTicket(itemId, convertProjectId);
      } finally {
        setConverting(false);
      }
    }, [itemId, convertProjectId]);

    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const handleOpenDeleteConfirm = useCallback(() => setDeleteConfirmOpen(true), []);
    const handleCloseDeleteConfirm = useCallback(() => setDeleteConfirmOpen(false), []);
    const handleDelete = useCallback(() => {
      void inboxApi.removeItem(itemId);
      onBack();
    }, [itemId, onBack]);

    const styles = useStyles();

    if (!item) {
      return (
        <div className={styles.notFound}>
          <p className={styles.notFoundText}>Item not found</p>
        </div>
      );
    }

    const days = item.status === 'open' ? daysRemaining(item, Date.now()) : null;
    const isShaped = !!item.shaping;

    return (
      <div className={styles.root}>
        <TopAppBar
          title={item.title}
          onBack={onBack}
          actions={
            <span className={styles.headerDate}>
              {new Date(item.createdAt).toLocaleDateString()}
            </span>
          }
        />

        {/* Body */}
        <div className={styles.body}>
          <div className={styles.bodyInner}>
            {/* Expiry countdown */}
            {days !== null && !isShaped && (
              <div
                className={mergeClasses(
                  styles.expiryBanner,
                  days <= 1 ? styles.expiryUrgent : styles.expiryNormal
                )}
              >
                {days <= 0
                  ? 'Expiring today — shape or it moves to icebox'
                  : `${days} day${days !== 1 ? 's' : ''} until this moves to icebox`}
              </div>
            )}

            {/* Title & Description card */}
            <div className={styles.card}>
              <input
                value={title}
                onChange={handleTitleChange}
                placeholder="Title"
                className={styles.inputClass}
              />
              <Textarea
                value={description}
                onChange={handleDescriptionChange}
                placeholder="Add context, details, or paste raw content..."
                rows={4}
              />
              {dirty && (
                <div className={styles.saveRow}>
                  <Button size="sm" onClick={handleSave} isDisabled={!title.trim()}>
                    Save
                  </Button>
                </div>
              )}
            </div>

            {/* Shaping */}
            {item.status !== 'done' && !isShaped && (
              <ShapingForm onSave={handleShapeSave} />
            )}

            {/* Shaped — read-only display */}
            {isShaped && (
              <div className={mergeClasses(styles.card, styles.cardAccent)}>
                <SectionLabel>Shaped</SectionLabel>
                <div className={styles.shapedContent}>
                  <div>
                    <span className={styles.shapedLabel}>Done looks like</span>
                    <p className={styles.shapedValue}>{item.shaping!.doneLooksLike}</p>
                  </div>
                  <div>
                    <span className={styles.shapedLabel}>Appetite</span>
                    <div className={styles.shapedBadge}>
                      <Badge color={APPETITE_COLORS[item.shaping!.appetite]}>
                        {APPETITE_LABELS[item.shaping!.appetite]} — {APPETITE_DESCRIPTIONS[item.shaping!.appetite]}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <span className={styles.shapedLabel}>Out of scope</span>
                    <p className={styles.shapedValue}>{item.shaping!.outOfScope}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Convert to ticket — only when shaped */}
            {isShaped && item.status !== 'done' && (
              <div className={styles.card}>
                <SectionLabel>Convert to Ticket</SectionLabel>
                <Select
                  value={convertProjectId}
                  onChange={(e) => setConvertProjectId(e.target.value)}
                >
                  {store.projects.length === 0 && <option value="">No projects</option>}
                  {store.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  onClick={handleConvertToTicket}
                  isDisabled={converting || !convertProjectId}
                  className={styles.convertBtn}
                >
                  <Open20Regular style={{ width: 14, height: 14 }} className={styles.convertIcon} />
                  Send to Backlog
                </Button>
              </div>
            )}

            {/* Status chips */}
            <div className={styles.card}>
              <SectionLabel>Status</SectionLabel>
              <div className={styles.statusRow}>
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleStatusChange(opt.value)}
                    className={mergeClasses(
                      styles.statusChip,
                      item.status === opt.value ? styles.statusActive : styles.statusInactive
                    )}
                  >
                    <span className={cn(styles.statusDot, opt.dot)} />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className={styles.actionsRow}>
              <Button size="sm" variant="destructive" onClick={handleOpenDeleteConfirm} className={styles.deleteBtn}>
                Delete
              </Button>
            </div>
          </div>
        </div>
        <ConfirmDialog
          open={deleteConfirmOpen}
          onClose={handleCloseDeleteConfirm}
          onConfirm={handleDelete}
          title="Delete inbox item?"
          description="This item will be permanently removed."
          confirmLabel="Delete"
          destructive
        />
      </div>
    );
  }
);
InboxDetail.displayName = 'InboxDetail';
