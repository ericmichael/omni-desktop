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
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconButton, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, ProjectId } from '@/shared/types';

import { inboxApi } from './state';

/**
 * Detail view for a single inbox item. Opens in place of the list when the
 * user clicks a row. Auto-saves title/note on blur. Action buttons
 * at the bottom cover the rest of the lifecycle (defer, promote, drop).
 *
 * Promoted tombstones render read-only — no edits, just a "this became X" label.
 */

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
  hideHeader?: boolean;
};

export const InboxItemDetail = memo(({ item, onBack, hideHeader = false }: InboxItemDetailProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);

  const isArchived = !!item.promotedTo;

  // Local edit buffers — seeded once from props on mount. The parent keys
  // this component on `item.id`, so navigating to a different item gives
  // us a fresh lifecycle with fresh initial state. That keying is what
  // makes the buffers safe: useState initializers run on mount, so there
  // is no code path where a stale buffer from a previous item can end up
  // associated with a different item's id.
  //
  // Same-id external updates (store broadcasts) intentionally do NOT
  // refresh these buffers — clobbering a user's in-progress edit would be
  // worse than showing slightly stale data.
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');

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
  // Flush-on-unmount.
  //
  // If the user types in a field and navigates away without blurring
  // (clicks another inbox item, hits the back button, closes the panel),
  // the in-progress edit would otherwise be lost. The latest save closures
  // are captured in a ref on every render so the unmount cleanup can call
  // the most recent version — which closes over the current buffers AND
  // the current `item.id`, so the write always lands on the right row.
  //
  // The cleanup effect has an empty dep array so it only fires once on
  // real unmount (i.e. when the parent swaps our `key` for a new item or
  // when the panel closes), not after every keystroke.
  // -------------------------------------------------------------------------
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    saveTitleNote();
  };
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleDefer = useCallback(() => {
    void inboxApi.defer(item.id);
  }, [item.id]);

  const handleReactivate = useCallback(() => {
    void inboxApi.reactivate(item.id);
  }, [item.id]);

  const handleTitleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
  }, []);

  const handleNoteChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setNote(event.target.value);
  }, []);

  const handleProjectChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setProjectId(event.target.value || null);
    },
    [setProjectId]
  );

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
      {!hideHeader && (
        <div className={styles.header}>
          <button type="button" className={styles.backBtn} onClick={onBack} aria-label="Back">
            <ArrowLeft20Regular />
            Back
          </button>
          <div className={styles.spacer} />
          <div className={styles.meta}>{statusBadge}</div>
        </div>
      )}

      {/* Body */}
      <div className={styles.body}>
        {isArchived && (
          <div className={styles.readonlyBanner}>
            This item was promoted to a {item.promotedTo!.kind} on {new Date(item.promotedTo!.at).toLocaleString()}.
            It&apos;s kept as a tombstone for undo and audit. Edits are disabled.
          </div>
        )}

        <input
          type="text"
          className={styles.titleInput}
          value={title}
          onChange={handleTitleChange}
          onBlur={saveTitleNote}
          placeholder="Untitled"
          readOnly={isArchived}
        />

        <textarea
          className={styles.noteInput}
          value={note}
          onChange={handleNoteChange}
          onBlur={saveTitleNote}
          placeholder="Add a note — what does done look like? Anything out of scope?"
          readOnly={isArchived}
        />

        {/* Project association */}
        <div className={styles.projectRow}>
          <span className={styles.fieldLabel}>Project:</span>
          <select
            className={styles.select}
            value={item.projectId ?? ''}
            onChange={handleProjectChange}
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

      </div>

      {/* Actions */}
      {!isArchived && (
        <div className={styles.actionsBar}>
          <button type="button" className={styles.primaryBtn} onClick={handlePromoteToTicket}>
            <Rocket20Regular /> Promote to ticket
          </button>
          <Menu positioning={{ position: 'above', align: 'end' }}>
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label="More actions" icon={<MoreHorizontal20Filled />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {item.status === 'later' ? (
                  <MenuItem icon={<ArrowCounterclockwise20Regular />} onClick={handleReactivate}>
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
                <MenuItem icon={<Delete20Regular />} onClick={handleDrop} className={styles.dangerMenuItem}>
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
