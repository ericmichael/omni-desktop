import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowLeft20Regular, Delete20Regular, MoreHorizontal20Filled, Rocket20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatTimestamp } from '@/lib/format-time';
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  SectionLabel,
  Select,
} from '@/renderer/ds';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { toast } from '@/renderer/features/Toast/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, ProjectId } from '@/shared/types';

import { inboxApi } from './state';

/**
 * Detail view for a single inbox item. On desktop it fills the right pane
 * next to the list; on mobile (`showBack`) it replaces the list and gets a
 * back header. Standard detail anatomy, matching the ticket Overview: the
 * title (with the triage actions on its row) above a content + properties
 * split — the note on the left, Status / Project / Details in the right
 * rail. Auto-saves title/note on blur.
 *
 * Promoted tombstones render read-only — no edits, just a "this became X" banner.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
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
  /* Header band — mirrors ProjectPageHeader's geometry (the ticket page's
     header), with the tab-row border standing in for the tabs it lacks. */
  pageHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXL,
  },
  bodyInner: {
    width: '100%',
    maxWidth: '56rem',
    marginLeft: 'auto',
    marginRight: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  /* Content + properties rail — same split as the ticket Overview. The pane
     sits next to the 320px inbox list, so stack a bit earlier than the
     ticket page does. */
  split: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 1000px)': {
      flexDirection: 'column',
    },
  },
  main: {
    flex: '1 1 0',
    minWidth: 0,
    '@media (max-width: 1000px)': {
      width: '100%',
      flex: '0 0 auto',
    },
  },
  aside: {
    width: '240px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    '@media (max-width: 1000px)': {
      width: '100%',
    },
  },
  prop: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  propControl: {
    width: '100%',
  },
  detailRow: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  titleInput: {
    flex: '1 1 0',
    minWidth: 0,
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground3 },
  },
  noteInput: {
    width: '100%',
    minHeight: '80px',
    resize: 'vertical',
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    fontFamily: 'inherit',
    lineHeight: tokens.lineHeightBase400,
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground3 },
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export type InboxItemDetailProps = {
  item: InboxItem;
  onBack: () => void;
  /** Mobile: render the back header (the detail replaced the list). */
  showBack?: boolean;
};

export const InboxItemDetail = memo(({ item, onBack, showBack = true }: InboxItemDetailProps) => {
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

  const handleStatusChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (event.target.value === 'later') {
        void inboxApi.defer(item.id);
      } else {
        void inboxApi.reactivate(item.id);
      }
    },
    [item.id]
  );

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
      toast.warning('No project to promote into', 'Create a project first, then promote this item.');
      return;
    }
    const projectLabel = store.projects.find((p) => p.id === projectId)?.label ?? 'project';
    void inboxApi.promoteToTicket(item.id, { projectId }).then((ticket) => {
      // Say where it went and offer the jump — the item itself just moved to
      // the Archive tab, which is otherwise silent.
      toast.success(`Promoted to task in ${projectLabel}`, undefined, {
        action: { label: 'Open', onClick: ticketApi.goToTicket.bind(null, ticket.id) },
      });
    });
  }, [item.id, item.projectId, store.projects]);

  const handlePromoteToProject = useCallback(() => {
    void inboxApi.promoteToProject(item.id, { label: item.title });
  }, [item.id, item.title]);

  const handleDrop = useCallback(() => {
    void inboxApi.remove(item.id);
    onBack();
  }, [item.id, onBack]);

  // -------------------------------------------------------------------------
  // Keyboard: Escape → back (mobile) / deselect (desktop)
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

  const capturedLabel = useMemo(() => `Captured ${formatTimestamp(item.createdAt)}`, [item.createdAt]);

  return (
    <div className={styles.root}>
      {showBack && (
        <div className={styles.header}>
          <button type="button" className={styles.backBtn} onClick={onBack} aria-label="Back">
            <ArrowLeft20Regular />
            Back
          </button>
        </div>
      )}

      {/* Header band — same geometry as the ticket page's ProjectPageHeader:
          full-bleed title row with the triage actions at the right. */}
      <div className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <input
            type="text"
            className={styles.titleInput}
            value={title}
            onChange={handleTitleChange}
            onBlur={saveTitleNote}
            placeholder="Untitled"
            readOnly={isArchived}
            aria-label="Item title"
          />
          {!isArchived && (
            <>
              <Button size="sm" leftIcon={<Rocket20Regular />} onClick={handlePromoteToTicket}>
                Promote to task
              </Button>
              <Menu positioning={{ position: 'below', align: 'end' }}>
                <MenuTrigger disableButtonEnhancement>
                  <IconButton aria-label="More actions" icon={<MoreHorizontal20Filled />} size="sm" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<Rocket20Regular />} onClick={handlePromoteToProject}>
                      Promote to project
                    </MenuItem>
                    <MenuItem icon={<Delete20Regular />} onClick={handleDrop} className={styles.dangerMenuItem}>
                      Drop
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </>
          )}
        </div>
      </div>

      {/* Scrollable content — centered like the ticket Overview. */}
      <div className={styles.body}>
        <div className={styles.bodyInner}>
          {isArchived && (
            <MessageBar intent="info">
              <MessageBarBody>
                Promoted to a {item.promotedTo!.kind} on {new Date(item.promotedTo!.at).toLocaleDateString()} — kept for
                history. Editing is disabled.
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Content + properties rail — same split as the ticket Overview. */}
          <div className={styles.split}>
            <div className={styles.main}>
              <textarea
                className={styles.noteInput}
                value={note}
                onChange={handleNoteChange}
                onBlur={saveTitleNote}
                placeholder="Add a note — what does done look like? Anything out of scope?"
                readOnly={isArchived}
              />
            </div>

            <aside className={styles.aside} aria-label="Item properties">
              {!isArchived && (
                <div className={styles.prop}>
                  <SectionLabel>Status</SectionLabel>
                  <Select
                    size="sm"
                    className={styles.propControl}
                    value={item.status}
                    onChange={handleStatusChange}
                    aria-label="Status"
                  >
                    <option value="new">Inbox</option>
                    <option value="later">Later</option>
                  </Select>
                </div>
              )}

              <div className={styles.prop}>
                <SectionLabel>Project</SectionLabel>
                <Select
                  size="sm"
                  className={styles.propControl}
                  value={item.projectId ?? ''}
                  onChange={handleProjectChange}
                  disabled={isArchived}
                  aria-label="Project"
                >
                  <option value="">No project</option>
                  {store.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div className={styles.prop}>
                <SectionLabel>Details</SectionLabel>
                <div className={styles.detailRow}>
                  <span>{capturedLabel}</span>
                  {item.updatedAt !== item.createdAt && <span>Updated {formatTimestamp(item.updatedAt)}</span>}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
});
InboxItemDetail.displayName = 'InboxItemDetail';
