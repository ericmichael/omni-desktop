/**
 * Console tab — displays messages captured from the webview's
 * `onConsoleMessage` callback. BrowserView buffers entries and passes them in.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Delete16Regular } from '@fluentui/react-icons';
import { memo, useEffect, useRef, useState } from 'react';

import type { ConsoleMessage } from '@/renderer/common/Webview';

type Entry = ConsoleMessage & { timestamp: number };
type LevelFilter = 'all' | 'log' | 'warn' | 'error';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    height: '28px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
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
  filterActive: { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
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
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: '4px 0',
    fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, monospace",
    fontSize: '12px',
  },
  row: {
    padding: '2px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralBackground3}`,
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  time: {
    flex: '0 0 56px',
    color: tokens.colorNeutralForeground4,
    fontSize: '10px',
  },
  level: {
    flex: '0 0 40px',
    fontSize: '10px',
    textTransform: 'uppercase',
  },
  log: { color: tokens.colorNeutralForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1, backgroundColor: 'rgba(255, 200, 0, 0.06)' },
  error: { color: tokens.colorPaletteRedForeground1, backgroundColor: 'rgba(255, 80, 80, 0.06)' },
  empty: { padding: '24px', textAlign: 'center', color: tokens.colorNeutralForeground4, fontFamily: 'inherit' },
});

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d
    .getSeconds()
    .toString()
    .padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0').slice(0, 2)}`;
}

export const ConsoleTab = memo(({ entries, onClear }: { entries: Entry[]; onClear: () => void }) => {
  const styles = useStyles();
  const [level, setLevel] = useState<LevelFilter>('all');
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries — standard devtools behavior.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Only auto-scroll if the user is already near the bottom.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const filtered = level === 'all' ? entries : entries.filter((e) => e.level === level);

  const counts = {
    all: entries.length,
    log: entries.filter((e) => e.level === 'log').length,
    warn: entries.filter((e) => e.level === 'warn').length,
    error: entries.filter((e) => e.level === 'error').length,
  };

  const LEVELS: { id: LevelFilter; label: string }[] = [
    { id: 'all', label: `All (${counts.all})` },
    { id: 'log', label: `Log (${counts.log})` },
    { id: 'warn', label: `Warn (${counts.warn})` },
    { id: 'error', label: `Error (${counts.error})` },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={mergeClasses(styles.filter, level === l.id && styles.filterActive)}
            onClick={() => setLevel(l.id)}
          >
            {l.label}
          </button>
        ))}
        <div className={styles.spacer} />
        <button type="button" className={styles.iconBtn} onClick={onClear} title="Clear console">
          <Delete16Regular />
        </button>
      </div>
      <div ref={listRef} className={styles.list}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>Nothing logged yet.</div>
        ) : (
          filtered.map((e, i) => (
            <div key={i} className={mergeClasses(styles.row, styles[e.level])}>
              <span className={styles.time}>{formatTime(e.timestamp)}</span>
              <span className={styles.level}>{e.level}</span>
              <span>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
});
ConsoleTab.displayName = 'ConsoleTab';
