/**
 * Downloads tray — a toolbar button that opens a dropdown listing every
 * download the main-process `DownloadsManager` has tracked this session.
 *
 * Click a completed item to open it; the context menu exposes "show in
 * folder" and "remove from list". A small badge on the button surfaces the
 * count of active downloads so users notice progress even without opening
 * the tray.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ArrowDownload20Regular, CheckmarkCircle16Regular, Delete16Regular, ErrorCircle16Regular, FolderOpen16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { memo, useCallback, useState } from 'react';

import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { BrowserDownloadEntry } from '@/shared/types';

export const $downloads = atom<BrowserDownloadEntry[]>([]);

ipc.on('browser:downloads-changed', (list) => {
  $downloads.set(list ?? []);
});

void emitter
  .invoke('browser:downloads-list')
  .then((list) => $downloads.set(list ?? []))
  .catch(() => {
    /* server mode / race — atom already has [] */
  });

const useStyles = makeStyles({
  btn: {
    position: 'relative',
    display: 'inline-flex',
    width: '26px',
    height: '26px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  badge: {
    position: 'absolute',
    top: '-2px',
    right: '-2px',
    minWidth: '14px',
    height: '14px',
    padding: '0 3px',
    borderRadius: '7px',
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: '9px',
    fontWeight: tokens.fontWeightSemibold,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  panel: {
    width: '320px',
    maxHeight: '400px',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  title: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  clearBtn: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: tokens.borderRadiusSmall,
    ':hover': { color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: '4px',
  },
  empty: {
    padding: '20px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowInner: { flex: '1 1 0', minWidth: 0 },
  filename: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  progressBar: {
    position: 'relative',
    height: '2px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '1px',
    marginTop: '4px',
    overflow: 'hidden',
  },
  progressFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: tokens.colorBrandBackground,
    transitionProperty: 'width',
    transitionDuration: '150ms',
  },
  iconOk: { color: tokens.colorPaletteGreenForeground1, width: '16px', height: '16px', flexShrink: 0 },
  iconErr: { color: tokens.colorPaletteRedForeground1, width: '16px', height: '16px', flexShrink: 0 },
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
return `${bytes} B`;
}
  if (bytes < 1024 * 1024) {
return `${(bytes / 1024).toFixed(0)} KB`;
}
  if (bytes < 1024 * 1024 * 1024) {
return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DownloadRow = memo(({ entry }: { entry: BrowserDownloadEntry }) => {
  const styles = useStyles();
  const pct =
    entry.totalBytes > 0 ? Math.min(100, Math.round((entry.receivedBytes / entry.totalBytes) * 100)) : 0;

  const handleOpen = useCallback(() => {
    if (entry.state !== 'completed') {
return;
}
    void emitter.invoke('browser:downloads-open-file', entry.id).catch(() => {});
  }, [entry.id, entry.state]);

  const handleShowFolder = useCallback(() => {
    void emitter.invoke('browser:downloads-show-in-folder', entry.id).catch(() => {});
  }, [entry.id]);

  const handleRemove = useCallback(() => {
    void emitter.invoke('browser:downloads-remove', entry.id).catch(() => {});
  }, [entry.id]);

  return (
    <Menu positioning={{ position: 'below', align: 'start' }} openOnContext>
      <MenuTrigger>
        <div className={styles.row} onClick={handleOpen} role="button" tabIndex={0}>
          {entry.state === 'completed' ? (
            <CheckmarkCircle16Regular className={styles.iconOk} />
          ) : entry.state === 'interrupted' || entry.state === 'cancelled' ? (
            <ErrorCircle16Regular className={styles.iconErr} />
          ) : (
            <ArrowDownload20Regular style={{ width: 14, height: 14, flexShrink: 0 }} />
          )}
          <div className={styles.rowInner}>
            <div className={styles.filename}>{entry.filename}</div>
            <div className={styles.meta}>
              {entry.state === 'completed'
                ? formatBytes(entry.receivedBytes)
                : entry.state === 'cancelled'
                  ? 'Cancelled'
                  : entry.state === 'interrupted'
                    ? 'Failed'
                    : `${formatBytes(entry.receivedBytes)} / ${formatBytes(entry.totalBytes)}`}
            </div>
            {(entry.state === 'progressing' || entry.state === 'paused') && (
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        </div>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {entry.state === 'completed' && <MenuItem onClick={handleOpen}>Open</MenuItem>}
          {entry.savePath && (
            <MenuItem icon={<FolderOpen16Regular />} onClick={handleShowFolder}>
              Show in folder
            </MenuItem>
          )}
          <MenuItem icon={<Delete16Regular />} onClick={handleRemove}>
            Remove from list
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
});
DownloadRow.displayName = 'DownloadRow';

export const DownloadsTray = memo(() => {
  const styles = useStyles();
  const items = useStore($downloads);
  const [open, setOpen] = useState(false);

  const activeCount = items.filter((e) => e.state === 'progressing' || e.state === 'paused').length;

  const handleClear = useCallback(() => {
    void emitter.invoke('browser:downloads-clear').catch(() => {});
  }, []);

  if (items.length === 0 && !open) {
    // Hide the button entirely when nothing has downloaded yet — less chrome
    // for the common case. Menu re-appears the moment a download starts.
    return null;
  }

  return (
    <Menu open={open} onOpenChange={(_, data) => setOpen(data.open)} positioning={{ position: 'below', align: 'end' }}>
      <MenuTrigger>
        <button
          type="button"
          className={styles.btn}
          aria-label="Downloads"
          title={`Downloads (${items.length})`}
        >
          <ArrowDownload20Regular style={{ width: 14, height: 14 }} />
          {activeCount > 0 && <span className={styles.badge}>{activeCount}</span>}
        </button>
      </MenuTrigger>
      <MenuPopover>
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.title}>Downloads</span>
            {items.length > 0 && (
              <button type="button" className={styles.clearBtn} onClick={handleClear}>
                Clear completed
              </button>
            )}
          </div>
          <div className={styles.list}>
            {items.length === 0 ? (
              <div className={styles.empty}>No downloads yet.</div>
            ) : (
              items.map((e) => <DownloadRow key={e.id} entry={e} />)
            )}
          </div>
        </div>
      </MenuPopover>
    </Menu>
  );
});
DownloadsTray.displayName = 'DownloadsTray';
