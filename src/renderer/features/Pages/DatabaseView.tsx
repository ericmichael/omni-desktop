import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { memo, useCallback, useMemo, useState } from 'react';

import type { Page, PageId } from '@/shared/types';

/**
 * Generic page browser. Pure list view over a slice of pages — no status
 * filtering, no property cells, no grouping. Inbox lifecycle lives on
 * `InboxItem`, not on pages; this component is for browsing knowledge
 * pages (docs, notes, briefs) inside a project.
 *
 * Callers provide the pre-filtered list (e.g. "children of parent X" or
 * "all pages in project Y") and handle opening / creating via callbacks.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '8px',
    paddingBottom: '8px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: 'transparent',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  icon: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase400,
    width: '20px',
    textAlign: 'center',
  },
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  time: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  createRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '10px',
    paddingBottom: '10px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
  },
  createInput: {
    flex: '1 1 0',
    backgroundColor: 'transparent',
    border: 'none',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground3 },
  },
});

export type DatabaseViewMode = 'table' | 'list';

export type DatabaseViewProps = {
  pages: Page[];
  mode?: DatabaseViewMode;
  onOpen?: (id: PageId) => void;
  onCreate?: (input: { title: string }) => Promise<unknown> | unknown;
  createPlaceholder?: string;
  emptyState?: string;
};

export const DatabaseView = memo(
  ({
    pages,
    onOpen,
    onCreate,
    createPlaceholder = 'New page…',
    emptyState = 'No pages yet.',
  }: DatabaseViewProps) => {
    const styles = useStyles();
    const [draft, setDraft] = useState('');

    const sorted = useMemo(
      () => [...pages].sort((a, b) => b.updatedAt - a.updatedAt),
      [pages]
    );

    const submit = useCallback(async () => {
      const title = draft.trim();
      if (!title || !onCreate) return;
      await onCreate({ title });
      setDraft('');
    }, [draft, onCreate]);

    return (
      <div className={styles.root}>
        {sorted.length === 0 ? (
          <div className={styles.empty}>{emptyState}</div>
        ) : (
          sorted.map((page) => (
            <button
              key={page.id}
              type="button"
              className={styles.row}
              onClick={() => onOpen?.(page.id)}
            >
              <span className={styles.icon}>{page.icon ?? '📄'}</span>
              <span className={styles.title}>{page.title || 'Untitled'}</span>
              <span className={styles.time}>{formatRelative(page.updatedAt)}</span>
            </button>
          ))
        )}
        {onCreate && (
          <div className={styles.createRow}>
            <span className={styles.icon}>＋</span>
            <input
              className={styles.createInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                } else if (e.key === 'Escape') {
                  setDraft('');
                }
              }}
              placeholder={createPlaceholder}
            />
          </div>
        )}
      </div>
    );
  }
);
DatabaseView.displayName = 'DatabaseView';

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  return `${Math.floor(delta / day)}d`;
}
