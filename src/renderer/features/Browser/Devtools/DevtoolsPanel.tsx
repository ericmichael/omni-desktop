/**
 * Bottom-docked Devtools panel for the browser surface.
 *
 * Lives inside a BrowserView's body as an absolutely-positioned overlay so it
 * scopes to the active webview (each tabset/tab has its own panel instance).
 * Tabs: Network, Console, Storage, Elements. Resizable via a top-edge drag
 * handle. Closed by default; toggled with `Cmd+Alt+I` from BrowserView.
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { ConsoleMessage } from '@/renderer/common/Webview';
import { ConsoleTab } from '@/renderer/features/Browser/Devtools/ConsoleTab';
import { ElementsTab } from '@/renderer/features/Browser/Devtools/ElementsTab';
import { NetworkTab } from '@/renderer/features/Browser/Devtools/NetworkTab';
import { StorageTab } from '@/renderer/features/Browser/Devtools/StorageTab';
import type { AppHandleId } from '@/shared/app-control-types';

export type DevtoolsTab = 'network' | 'console' | 'storage' | 'elements';

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: '0 -6px 16px -8px rgba(0, 0, 0, 0.15)',
    zIndex: 15,
  },
  resizeHandle: {
    position: 'absolute',
    top: '-3px',
    left: 0,
    right: 0,
    height: '6px',
    cursor: 'row-resize',
    zIndex: 1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    height: '30px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    gap: '2px',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  tab: {
    height: '24px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  tabActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  spacer: { flex: '1 1 0' },
  closeBtn: {
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
  body: {
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
});

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 600;

export const DevtoolsPanel = memo(
  ({
    handleId,
    activeOrigin,
    consoleLog,
    onClear,
    onClose,
  }: {
    handleId: AppHandleId;
    activeOrigin: string | null;
    consoleLog: Array<ConsoleMessage & { timestamp: number }>;
    onClear: () => void;
    onClose: () => void;
  }) => {
    const styles = useStyles();
    const [tab, setTab] = useState<DevtoolsTab>('network');
    const [height, setHeight] = useState(280);
    const draggingRef = useRef(false);
    const startYRef = useRef(0);
    const startHeightRef = useRef(280);

    // Resize via a top-edge drag handle. We listen at the document level so
    // the drag keeps working when the cursor momentarily leaves the handle.
    const handleDown = useCallback((e: React.MouseEvent) => {
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      document.body.style.userSelect = 'none';
    }, [height]);

    useEffect(() => {
      const onMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startYRef.current - e.clientY;
        const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + delta));
        setHeight(next);
      };
      const onUp = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      return () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
    }, []);

    return (
      <div className={styles.root} style={{ height }}>
        <div className={styles.resizeHandle} onMouseDown={handleDown} role="separator" aria-orientation="horizontal" />
        <div className={styles.header}>
          {(['network', 'console', 'storage', 'elements'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={mergeClasses(styles.tab, tab === t && styles.tabActive)}
              onClick={() => setTab(t)}
            >
              {t === 'network' ? 'Network' : t === 'console' ? 'Console' : t === 'storage' ? 'Storage' : 'Elements'}
            </button>
          ))}
          <div className={styles.spacer} />
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Close devtools"
            title="Close (Cmd+Alt+I)"
            onClick={onClose}
          >
            <Dismiss16Regular />
          </button>
        </div>
        <div className={styles.body}>
          {tab === 'network' && <NetworkTab handleId={handleId} />}
          {tab === 'console' && <ConsoleTab entries={consoleLog} onClear={onClear} />}
          {tab === 'storage' && <StorageTab handleId={handleId} activeOrigin={activeOrigin} />}
          {tab === 'elements' && <ElementsTab handleId={handleId} />}
        </div>
      </div>
    );
  }
);
DevtoolsPanel.displayName = 'DevtoolsPanel';
