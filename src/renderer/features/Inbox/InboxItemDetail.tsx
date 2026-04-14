import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import {
  ArchiveRegular,
  ArrowCounterclockwise20Regular,
  ArrowLeft20Regular,
  Delete20Regular,
  MoreHorizontal20Filled,
  Rocket20Regular,
  TimerRegular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, InboxShaping, ProjectId } from '@/shared/types';

import { inboxApi } from './state';

/**
 * Detail view for a single inbox item. Opens in place of the list when the
 * user clicks a row. Auto-saves title/note/shaping on blur. Action buttons
 * at the bottom cover the rest of the lifecycle (defer, promote, drop).
 *
 * Promoted tombstones render read-only — no edits, just a "this became X" label.
 */

const APPETITE_OPTIONS: Array<{ value: InboxShaping['appetite']; label: string; hint: string }> = [
  { value: 'small', label: 'Small', hint: '~1 day' },
  { value: 'medium', label: 'Medium', hint: '2–4 days' },
  { value: 'large', label: 'Large', hint: '1–2 weeks' },
  { value: 'xl', label: 'XL', hint: '3+ weeks' },
];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    flexShrink: 0,
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '6px 10px',
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  spacer: { flex: '1 1 0' },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase100,
  },
  shapedBadge: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  laterBadge: {
    backgroundColor: tokens.colorPaletteYellowBackground2,
    color: tokens.colorPaletteYellowForeground2,
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
  },
  titleInput: {
    width: '100%',
    backgroundColor: 'transparent',
    border: 'none',
    fontSize: '28px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground3 },
  },
  noteInput: {
    width: '100%',
    minHeight: '80px',
    resize: 'vertical',
    backgroundColor: 'transparent',
    border: 'none',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    fontFamily: 'inherit',
    lineHeight: tokens.lineHeightBase400,
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground3 },
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  sectionLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  fieldLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  input: {
    width: '100%',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '8px 12px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    ':focus': { outline: 'none', ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  textarea: {
    minHeight: '60px',
    resize: 'vertical',
  },
  appetiteRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  appetiteBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  appetiteBtnActive: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
  },
  appetiteLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  appetiteHint: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  projectRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  select: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '6px 10px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  actionsBar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  primaryBtn: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '8px 14px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    ...shorthands.border('1px', 'solid', tokens.colorBrandBackground),
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorBrandBackgroundHover },
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  readonlyBanner: {
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
});

export type InboxItemDetailProps = {
  item: InboxItem;
  onBack: () => void;
};

export const InboxItemDetail = memo(({ item, onBack }: InboxItemDetailProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);

  const isArchived = !!item.promotedTo;

  // Local edit buffers. Seeded from props; updated on prop changes so
  // external store-sync broadcasts don't stomp in-progress edits (we only
  // snap to the store when the user hasn't touched that field yet).
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');
  const [outcome, setOutcome] = useState(item.shaping?.outcome ?? '');
  const [appetite, setAppetite] = useState<InboxShaping['appetite']>(
    item.shaping?.appetite ?? 'medium'
  );
  const [notDoing, setNotDoing] = useState(item.shaping?.notDoing ?? '');

  // Ref-captured version of the item id so effects that resync buffers only
  // fire when the user actually navigates to a different item, not on every
  // store update for the same item.
  const lastSyncedId = useRef(item.id);
  useEffect(() => {
    if (lastSyncedId.current !== item.id) {
      lastSyncedId.current = item.id;
      setTitle(item.title);
      setNote(item.note ?? '');
      setOutcome(item.shaping?.outcome ?? '');
      setAppetite(item.shaping?.appetite ?? 'medium');
      setNotDoing(item.shaping?.notDoing ?? '');
    }
  }, [item]);

  // -------------------------------------------------------------------------
  // Save handlers (auto-save on blur)
  // -------------------------------------------------------------------------

  const saveTitleNote = useCallback(() => {
    if (isArchived) {
return;
}
    const nextTitle = title.trim() || 'Untitled';
    const nextNote = note.trim();
    const titleChanged = nextTitle !== item.title;
    const noteChanged = nextNote !== (item.note ?? '');
    if (!titleChanged && !noteChanged) {
return;
}
    void inboxApi.update(item.id, {
      ...(titleChanged ? { title: nextTitle } : {}),
      ...(noteChanged ? { note: nextNote } : {}),
    });
  }, [isArchived, title, note, item]);

  const saveShaping = useCallback(() => {
    if (isArchived) {
return;
}
    const trimmedOutcome = outcome.trim();
    // Can't save shaping without an outcome — it's the one required field.
    // Silently skip; the user can come back and fill it in.
    if (!trimmedOutcome) {
return;
}
    const next: InboxShaping = { outcome: trimmedOutcome, appetite };
    if (notDoing.trim()) {
next.notDoing = notDoing.trim();
}
    // Skip if nothing changed.
    const existing = item.shaping;
    if (
      existing &&
      existing.outcome === next.outcome &&
      existing.appetite === next.appetite &&
      (existing.notDoing ?? '') === (next.notDoing ?? '')
    ) {
      return;
    }
    void inboxApi.shape(item.id, next);
  }, [isArchived, outcome, appetite, notDoing, item]);

  const setProjectId = useCallback(
    (id: ProjectId | null) => {
      if (isArchived) {
return;
}
      if ((item.projectId ?? null) === id) {
return;
}
      void inboxApi.update(item.id, { projectId: id });
    },
    [isArchived, item]
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleDefer = useCallback(() => {
    void inboxApi.defer(item.id);
  }, [item.id]);

  const handleReactivate = useCallback(() => {
    void inboxApi.reactivate(item.id);
  }, [item.id]);

  const handlePromoteToTicket = useCallback(() => {
    const projectId = item.projectId ?? store.projects.find((p) => p.isPersonal)?.id ?? store.projects[0]?.id;
    if (!projectId) {
       
      console.warn('[Inbox] No project available to promote to');
      return;
    }
    void inboxApi.promoteToTicket(item.id, { projectId });
  }, [item.id, item.projectId, store.projects]);

  const handlePromoteToProject = useCallback(() => {
    void inboxApi.promoteToProject(item.id, { label: item.title });
  }, [item.id, item.title]);

  const handleDrop = useCallback(() => {
    void inboxApi.remove(item.id);
    onBack();
  }, [item.id, onBack]);

  // -------------------------------------------------------------------------
  // Keyboard: Escape → back
  // -------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // -------------------------------------------------------------------------
  // Status badge + metadata
  // -------------------------------------------------------------------------

  const statusBadge = useMemo(() => {
    if (item.promotedTo) {
      return (
        <span className={styles.badge}>
          <ArchiveRegular style={{ width: 12, height: 12 }} /> Promoted to {item.promotedTo.kind}
        </span>
      );
    }
    if (item.status === 'shaped') {
      return <span className={`${styles.badge} ${styles.shapedBadge}`}>Shaped</span>;
    }
    if (item.status === 'later') {
      return (
        <span className={`${styles.badge} ${styles.laterBadge}`}>
          <TimerRegular style={{ width: 12, height: 12 }} /> Later
        </span>
      );
    }
    return <span className={styles.badge}>New</span>;
  }, [item.status, item.promotedTo, styles]);

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={onBack} aria-label="Back">
          <ArrowLeft20Regular />
          Back
        </button>
        <div className={styles.spacer} />
        <div className={styles.meta}>{statusBadge}</div>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {isArchived && (
          <div className={styles.readonlyBanner}>
            This item was promoted to a {item.promotedTo!.kind} on{' '}
            {new Date(item.promotedTo!.at).toLocaleString()}. It&apos;s kept as a tombstone for
            undo and audit. Edits are disabled.
          </div>
        )}

        <input
          type="text"
          className={styles.titleInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitleNote}
          placeholder="Untitled"
          readOnly={isArchived}
        />

        <textarea
          className={styles.noteInput}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveTitleNote}
          placeholder="Add a note…"
          readOnly={isArchived}
        />

        {/* Project association */}
        <div className={styles.projectRow}>
          <span className={styles.fieldLabel}>Project:</span>
          <select
            className={styles.select}
            value={item.projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value || null)}
            disabled={isArchived}
          >
            <option value="">No project</option>
            {store.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {/* Shaping */}
        <div className={styles.section}>
          <span className={styles.sectionLabel}>Shape</span>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="detail-outcome">
              Outcome — what does success look like?
            </label>
            <textarea
              id="detail-outcome"
              className={`${styles.input} ${styles.textarea}`}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              onBlur={saveShaping}
              placeholder="Users can log in via SSO."
              readOnly={isArchived}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Appetite</span>
            <div className={styles.appetiteRow}>
              {APPETITE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={isArchived}
                  className={`${styles.appetiteBtn} ${appetite === opt.value ? styles.appetiteBtnActive : ''}`}
                  onClick={() => {
                    setAppetite(opt.value);
                    // Fire shaping save after state flushes; defer to a microtask
                    // so `appetite` has the new value when `saveShaping` reads it.
                    queueMicrotask(saveShaping);
                  }}
                >
                  <span className={styles.appetiteLabel}>{opt.label}</span>
                  <span className={styles.appetiteHint}>{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="detail-notdoing">
              Not doing <span style={{ opacity: 0.6 }}>(optional)</span>
            </label>
            <textarea
              id="detail-notdoing"
              className={`${styles.input} ${styles.textarea}`}
              value={notDoing}
              onChange={(e) => setNotDoing(e.target.value)}
              onBlur={saveShaping}
              placeholder="Custom themes, org import."
              readOnly={isArchived}
            />
          </div>
        </div>
      </div>

      {/* Actions */}
      {!isArchived && (
        <div className={styles.actionsBar}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={handlePromoteToTicket}
          >
            <Rocket20Regular /> Promote to ticket
          </button>
          <Menu positioning={{ position: 'above', align: 'end' }}>
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label="More actions" icon={<MoreHorizontal20Filled />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {item.status === 'later' ? (
                  <MenuItem
                    icon={<ArrowCounterclockwise20Regular />}
                    onClick={handleReactivate}
                  >
                    Reactivate
                  </MenuItem>
                ) : (
                  <MenuItem icon={<TimerRegular />} onClick={handleDefer}>
                    Defer to later
                  </MenuItem>
                )}
                <MenuItem icon={<Rocket20Regular />} onClick={handlePromoteToProject}>
                  Promote to project
                </MenuItem>
                <MenuItem
                  icon={<Delete20Regular />}
                  onClick={handleDrop}
                  className={styles.dangerMenuItem}
                >
                  Drop
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      )}
    </div>
  );
});
InboxItemDetail.displayName = 'InboxItemDetail';
