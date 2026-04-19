/**
 * Storage tab — cookies, localStorage, sessionStorage for the active tab's
 * origin. Read-only for now beyond per-key delete + per-section clear-all;
 * full edit-cell UX is cheap to add later but not needed v1.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular, Delete16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId } from '@/shared/app-control-types';

type Cookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflowY: 'auto' },
  section: { display: 'flex', flexDirection: 'column', minHeight: 0 },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    position: 'sticky',
    top: 0,
    zIndex: 1,
  },
  sectionTitle: {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  counter: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  spacer: { flex: '1 1 0' },
  iconBtn: {
    display: 'inline-flex',
    width: '22px',
    height: '22px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  table: {
    width: '100%',
    fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, monospace",
    fontSize: '11px',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '3px 8px',
    fontSize: '10px',
    textTransform: 'uppercase',
    color: tokens.colorNeutralForeground3,
    letterSpacing: '0.04em',
    fontWeight: tokens.fontWeightRegular,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    position: 'sticky',
    top: 0,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  td: {
    padding: '3px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralBackground3}`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '200px',
  },
  tdValue: { color: tokens.colorNeutralForeground2 },
  tdAction: { width: '24px', padding: '2px 4px' },
  rowBtn: {
    width: '18px',
    height: '18px',
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorPaletteRedForeground1 },
  },
  empty: { padding: '16px 12px', color: tokens.colorNeutralForeground4, fontSize: tokens.fontSizeBase200 },
  warn: { padding: '8px 12px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

export const StorageTab = memo(
  ({ handleId, activeOrigin }: { handleId: AppHandleId; activeOrigin: string | null }) => {
    const styles = useStyles();
    const [cookies, setCookies] = useState<Cookie[]>([]);
    const [local, setLocal] = useState<Record<string, string>>({});
    const [session, setSession] = useState<Record<string, string>>({});

    const refresh = useCallback(async () => {
      try {
        const filter = activeOrigin ? { url: activeOrigin } : {};
        const [c, l, s] = await Promise.all([
          emitter.invoke('app:cookies-get', handleId, filter) as Promise<Cookie[]>,
          emitter.invoke('app:storage-get', handleId, 'local'),
          emitter.invoke('app:storage-get', handleId, 'session'),
        ]);
        setCookies(c ?? []);
        setLocal(l ?? {});
        setSession(s ?? {});
      } catch {
        // webview not ready — next refresh
      }
    }, [handleId, activeOrigin]);

    useEffect(() => {
      void refresh();
    }, [refresh]);

    const deleteCookie = useCallback(
      async (c: Cookie) => {
        const url = activeOrigin ?? `https://${(c.domain ?? '').replace(/^\./, '')}${c.path ?? '/'}`;
        try {
          await emitter.invoke('app:cookies-clear', handleId, { url, name: c.name });
          await refresh();
        } catch {
          // ignore
        }
      },
      [activeOrigin, handleId, refresh]
    );

    const clearCookies = useCallback(async () => {
      if (!window.confirm('Delete all cookies for this origin?')) return;
      const filter = activeOrigin ? { url: activeOrigin } : {};
      try {
        await emitter.invoke('app:cookies-clear', handleId, filter);
        await refresh();
      } catch {
        // ignore
      }
    }, [activeOrigin, handleId, refresh]);

    const clearStorage = useCallback(
      async (which: 'local' | 'session') => {
        if (!window.confirm(`Clear all ${which}Storage keys?`)) return;
        try {
          await emitter.invoke('app:storage-clear', handleId, which);
          await refresh();
        } catch {
          // ignore
        }
      },
      [handleId, refresh]
    );

    const renderKVTable = (rows: Record<string, string>, onClear: () => void, label: string) => {
      const keys = Object.keys(rows);
      return (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>{label}</span>
            <span className={styles.counter}>{keys.length}</span>
            <div className={styles.spacer} />
            <button type="button" className={styles.iconBtn} onClick={onClear} title={`Clear ${label}`}>
              <Delete16Regular />
            </button>
          </div>
          {keys.length === 0 ? (
            <div className={styles.empty}>No keys.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Key</th>
                  <th className={styles.th}>Value</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k}>
                    <td className={styles.td} title={k}>
                      {k}
                    </td>
                    <td className={`${styles.td} ${styles.tdValue}`} title={rows[k]}>
                      {rows[k]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      );
    };

    return (
      <div className={styles.root}>
        {!activeOrigin && (
          <div className={styles.warn}>Navigate to a page to see its storage.</div>
        )}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Cookies</span>
            <span className={styles.counter}>{cookies.length}</span>
            <span className={styles.counter}>{activeOrigin ? `— ${activeOrigin}` : ''}</span>
            <div className={styles.spacer} />
            <button type="button" className={styles.iconBtn} onClick={() => void refresh()} title="Refresh">
              <ArrowClockwise16Regular />
            </button>
            <button type="button" className={styles.iconBtn} onClick={() => void clearCookies()} title="Clear cookies">
              <Delete16Regular />
            </button>
          </div>
          {cookies.length === 0 ? (
            <div className={styles.empty}>No cookies.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Value</th>
                  <th className={styles.th}>Domain</th>
                  <th className={styles.th}>Path</th>
                  <th className={styles.th}>Flags</th>
                  <th className={styles.th} />
                </tr>
              </thead>
              <tbody>
                {cookies.map((c, i) => (
                  <tr key={`${c.domain ?? ''}-${c.path ?? ''}-${c.name}-${i}`}>
                    <td className={styles.td} title={c.name}>
                      {c.name}
                    </td>
                    <td className={`${styles.td} ${styles.tdValue}`} title={c.value}>
                      {c.value}
                    </td>
                    <td className={styles.td}>{c.domain ?? ''}</td>
                    <td className={styles.td}>{c.path ?? ''}</td>
                    <td className={styles.td}>
                      {[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite].filter(Boolean).join(' · ')}
                    </td>
                    <td className={styles.tdAction}>
                      <button
                        type="button"
                        className={styles.rowBtn}
                        onClick={() => void deleteCookie(c)}
                        aria-label={`Delete cookie ${c.name}`}
                        title="Delete cookie"
                      >
                        <Delete16Regular style={{ width: 12, height: 12 }} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {renderKVTable(local, () => void clearStorage('local'), 'Local storage')}
        {renderKVTable(session, () => void clearStorage('session'), 'Session storage')}
      </div>
    );
  }
);
StorageTab.displayName = 'StorageTab';
