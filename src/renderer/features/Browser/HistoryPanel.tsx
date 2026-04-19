/**
 * History panel overlay — opens via `Cmd+Shift+H` in a BrowserView. Searchable,
 * click-to-navigate, clear-all. Reads history lazily through `browserApi` so
 * the large history blob isn't duplicated in the browser-state atom.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Delete16Regular, Dismiss20Regular, Globe16Regular, Search16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { fallbackTitle } from '@/lib/url';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserHistoryEntry, BrowserProfileId } from '@/shared/types';

const useStyles = makeStyles({
  backdrop: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '48px',
  },
  panel: {
    width: 'min(640px, 90%)',
    maxHeight: '70%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow28,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 14px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    flex: '1 1 0',
  },
  inputWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  input: {
    flex: '1 1 0',
    minWidth: 0,
    height: '26px',
    padding: '0 6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
  },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: '4px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowUrl: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '40%',
  },
  rowTime: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    flexShrink: 0,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '26px',
    paddingLeft: '8px',
    paddingRight: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  empty: {
    padding: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
});

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) {
return 'just now';
}
  if (diff < 3_600_000) {
return `${Math.round(diff / 60_000)}m ago`;
}
  if (diff < 86_400_000) {
return `${Math.round(diff / 3_600_000)}h ago`;
}
  return new Date(ts).toLocaleDateString();
}

export const HistoryPanel = memo(
  ({
    profileId,
    onOpen,
    onClose,
  }: {
    profileId?: BrowserProfileId;
    onOpen: (url: string) => void;
    onClose: () => void;
  }) => {
    const styles = useStyles();
    const [query, setQuery] = useState('');
    const [entries, setEntries] = useState<BrowserHistoryEntry[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const seqRef = useRef(0);

    const refresh = useCallback(
      async (q: string) => {
        const seq = ++seqRef.current;
        const out = await browserApi.listHistory({
          query: q,
          limit: 200,
          ...(profileId ? { profileId } : {}),
        });
        if (seq === seqRef.current) {
setEntries(out);
}
      },
      [profileId]
    );

    useEffect(() => {
      inputRef.current?.focus();
      void refresh('');
    }, [refresh]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = e.target.value;
        setQuery(next);
        void refresh(next);
      },
      [refresh]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter' && entries.length > 0) {
          e.preventDefault();
          onOpen(entries[0]!.url);
          onClose();
        }
      },
      [entries, onClose, onOpen]
    );

    const handleClear = useCallback(async () => {
      await browserApi.clearHistory(profileId ? { profileId } : undefined);
      await refresh(query);
    }, [profileId, query, refresh]);

    const handleOpen = useCallback(
      (url: string) => {
        onOpen(url);
        onClose();
      },
      [onClose, onOpen]
    );

    return (
      <div
        className={styles.backdrop}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
onClose();
}
        }}
      >
        <div className={styles.panel} role="dialog" aria-label="History">
          <div className={styles.header}>
            <span className={styles.title}>History</span>
            <button type="button" className={styles.btn} onClick={onClose} aria-label="Close">
              <Dismiss20Regular style={{ width: 14, height: 14 }} />
            </button>
          </div>
          <div className={styles.inputWrap}>
            <Search16Regular />
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder="Search history"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className={styles.list}>
            {entries.length === 0 ? (
              <div className={styles.empty}>{query ? 'No matches' : 'Your history will appear here.'}</div>
            ) : (
              entries.map((e) => (
                <div key={e.id} className={styles.row} onClick={() => handleOpen(e.url)} role="button" tabIndex={0}>
                  <Globe16Regular />
                  <span className={styles.rowTitle}>{e.title ?? fallbackTitle(e.url)}</span>
                  <span className={styles.rowUrl}>{e.url}</span>
                  <span className={styles.rowTime}>{formatTime(e.visitedAt)}</span>
                </div>
              ))
            )}
          </div>
          <div className={styles.footer}>
            <span>{entries.length} entries</span>
            <button type="button" className={styles.btn} onClick={handleClear}>
              <Delete16Regular style={{ width: 12, height: 12 }} />
              Clear history
            </button>
          </div>
        </div>
      </div>
    );
  }
);
HistoryPanel.displayName = 'HistoryPanel';
