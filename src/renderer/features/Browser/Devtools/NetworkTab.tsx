/**
 * Network tab — polls `app:network-log` while mounted and renders a live
 * table of requests. Click a row to inspect request/response detail.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Delete16Regular, Search16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { NetworkLogEntry } from '@/main/app-control-cdp';
import { emitter } from '@/renderer/services/ipc';
import type { AppHandleId } from '@/shared/app-control-types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  input: {
    flex: '0 0 240px',
    height: '22px',
    padding: '0 6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusSmall,
    outline: 'none',
  },
  filter: {
    height: '22px',
    paddingLeft: '8px',
    paddingRight: '8px',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  filterActive: {
    backgroundColor: tokens.colorSubtleBackgroundHover,
    color: tokens.colorNeutralForeground1,
  },
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
  counter: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  split: { display: 'flex', flex: '1 1 0', minHeight: 0 },
  list: {
    flex: '1 1 0',
    minWidth: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    fontSize: tokens.fontSizeBase100,
    fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, monospace",
  },
  header: {
    display: 'grid',
    gridTemplateColumns: '60px 60px minmax(0, 1fr) 80px 80px 80px',
    columnGap: '8px',
    padding: '4px 10px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    position: 'sticky',
    top: 0,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '60px 60px minmax(0, 1fr) 80px 80px 80px',
    columnGap: '8px',
    padding: '3px 10px',
    cursor: 'pointer',
    borderBottom: `1px solid ${tokens.colorNeutralBackground3}`,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowSelected: { backgroundColor: tokens.colorSubtleBackgroundSelected },
  rowErr: { color: tokens.colorPaletteRedForeground1 },
  rowWarn: { color: tokens.colorPaletteYellowForeground1 },
  cell: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  url: { color: tokens.colorNeutralForeground1 },
  details: {
    flex: '0 0 340px',
    minHeight: 0,
    overflow: 'auto',
    padding: '10px 12px',
    ...shorthands.borderLeft('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
  },
  dtLabel: { fontSize: '10px', textTransform: 'uppercase', color: tokens.colorNeutralForeground3, marginTop: '10px' },
  dtValue: { wordBreak: 'break-all', fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, monospace", fontSize: '11px' },
  empty: { padding: '24px', textAlign: 'center', color: tokens.colorNeutralForeground4 },
});

type Filter = 'all' | 'xhr' | 'doc' | 'css' | 'js' | 'img' | 'err';

function matchesFilter(e: NetworkLogEntry, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'err') return (e.status ?? 0) >= 400 || !!e.errorText;
  const rt = (e.resourceType ?? '').toLowerCase();
  if (filter === 'xhr') return rt === 'xhr' || rt === 'fetch';
  if (filter === 'doc') return rt === 'document';
  if (filter === 'css') return rt === 'stylesheet';
  if (filter === 'js') return rt === 'script';
  if (filter === 'img') return rt === 'image' || rt === 'media' || rt === 'font';
  return true;
}

function formatDuration(e: NetworkLogEntry): string {
  if (e.endedAt === undefined) return '…';
  const ms = Math.max(0, (e.endedAt - e.startedAt) * 1000);
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const NetworkTab = memo(({ handleId }: { handleId: AppHandleId }) => {
  const styles = useStyles();
  const [entries, setEntries] = useState<NetworkLogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await emitter.invoke('app:network-log', handleId, { limit: 300 });
      setEntries(list ?? []);
    } catch {
      // webview not ready yet — retry on next tick
    }
  }, [handleId]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const handleClear = useCallback(async () => {
    try {
      await emitter.invoke('app:network-log', handleId, { clear: true, limit: 0 });
      setEntries([]);
      setSelectedId(null);
    } catch {
      // ignore
    }
  }, [handleId]);

  const filtered = entries.filter((e) => {
    if (!matchesFilter(e, filter)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return e.url.toLowerCase().includes(q) || e.method.toLowerCase().includes(q);
  });

  const selected = selectedId ? entries.find((e) => e.requestId === selectedId) ?? null : null;

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'xhr', label: 'XHR/Fetch' },
    { id: 'doc', label: 'Doc' },
    { id: 'js', label: 'JS' },
    { id: 'css', label: 'CSS' },
    { id: 'img', label: 'Img' },
    { id: 'err', label: 'Err' },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Search16Regular />
        <input
          type="text"
          className={styles.input}
          placeholder="Filter URL or method"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={mergeClasses(styles.filter, filter === f.id && styles.filterActive)}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className={styles.counter}>
          {filtered.length}/{entries.length}
        </span>
        <div className={styles.spacer} />
        <button type="button" className={styles.iconBtn} onClick={() => void handleClear()} title="Clear">
          <Delete16Regular />
        </button>
      </div>
      <div className={styles.split}>
        <div className={styles.list}>
          <div className={styles.header}>
            <span>Method</span>
            <span>Status</span>
            <span>URL</span>
            <span>Type</span>
            <span>Size</span>
            <span>Time</span>
          </div>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No requests yet.</div>
          ) : (
            filtered.map((e) => {
              const statusClass = e.errorText || (e.status ?? 0) >= 500
                ? styles.rowErr
                : (e.status ?? 0) >= 400
                  ? styles.rowWarn
                  : undefined;
              return (
                <div
                  key={e.requestId}
                  className={mergeClasses(styles.row, selectedId === e.requestId && styles.rowSelected, statusClass)}
                  onClick={() => setSelectedId(e.requestId)}
                  role="row"
                >
                  <span className={styles.cell}>{e.method}</span>
                  <span className={styles.cell}>{e.errorText ? '—' : e.status ?? '…'}</span>
                  <span className={`${styles.cell} ${styles.url}`} title={e.url}>
                    {e.url}
                  </span>
                  <span className={styles.cell}>{e.resourceType ?? ''}</span>
                  <span className={styles.cell}>{formatSize(e.encodedDataLength)}</span>
                  <span className={styles.cell}>{formatDuration(e)}</span>
                </div>
              );
            })
          )}
        </div>
        {selected && (
          <div className={styles.details}>
            <div className={styles.dtLabel}>Method</div>
            <div className={styles.dtValue}>{selected.method}</div>
            <div className={styles.dtLabel}>URL</div>
            <div className={styles.dtValue}>{selected.url}</div>
            <div className={styles.dtLabel}>Status</div>
            <div className={styles.dtValue}>
              {selected.status ?? '(pending)'} {selected.statusText ? `— ${selected.statusText}` : ''}
            </div>
            {selected.mimeType && (
              <>
                <div className={styles.dtLabel}>MIME</div>
                <div className={styles.dtValue}>{selected.mimeType}</div>
              </>
            )}
            {selected.resourceType && (
              <>
                <div className={styles.dtLabel}>Type</div>
                <div className={styles.dtValue}>{selected.resourceType}</div>
              </>
            )}
            {selected.encodedDataLength !== undefined && (
              <>
                <div className={styles.dtLabel}>Size</div>
                <div className={styles.dtValue}>{formatSize(selected.encodedDataLength)}</div>
              </>
            )}
            <div className={styles.dtLabel}>Timing</div>
            <div className={styles.dtValue}>{formatDuration(selected)}</div>
            {selected.errorText && (
              <>
                <div className={styles.dtLabel}>Error</div>
                <div className={styles.dtValue}>{selected.errorText}</div>
              </>
            )}
            {selected.fromCache && (
              <>
                <div className={styles.dtLabel}>Cache</div>
                <div className={styles.dtValue}>from disk cache</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
NetworkTab.displayName = 'NetworkTab';
