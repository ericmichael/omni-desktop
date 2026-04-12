import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { Add20Regular, Dismiss12Regular, Dismiss20Regular } from '@fluentui/react-icons';

import { IconButton } from '@/renderer/ds';
import { ConsoleXterm } from '@/renderer/features/Console/ConsoleXterm';
import {
  $isConsoleOpen,
  $terminals,
  $activeTerminalId,
  createTerminal,
  destroyTerminal,
  setActiveTerminal,
} from '@/renderer/features/Console/state';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', width: '100%', height: '100%', position: 'relative', flexDirection: 'column', minHeight: 0 },
  toolbar: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: '1 1 0',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': { display: 'none' },
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: '3px',
    paddingBottom: '3px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'color, background-color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  tabActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: `0 0 0 1px ${tokens.colorNeutralStroke1}`,
  },
  tabDead: {
    color: tokens.colorPaletteRedForeground1,
  },
  tabClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  addBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  closeBtn: {
    flexShrink: 0,
  },
  xtermWrap: { position: 'relative', width: '100%', height: '100%', minHeight: 0 },
  xtermPane: { position: 'absolute', inset: 0, padding: tokens.spacingHorizontalS },
  xtermPaneHidden: { display: 'none' },
});

const closeConsole = () => {
  $isConsoleOpen.set(false);
};

export const ConsoleStarted = memo(() => {
  const styles = useStyles();
  const terminals = useStore($terminals);
  const activeId = useStore($activeTerminalId);
  const store = useStore(persistedStoreApi.$atom);

  const handleNewTab = useCallback(() => {
    const cwd = store.workspaceDir ?? undefined;
    createTerminal(cwd);
  }, [store.workspaceDir]);

  const handleCloseTab = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    destroyTerminal(id);
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {terminals.map((t, i) => (
            <button
              key={t.id}
              type="button"
              className={mergeClasses(
                styles.tab,
                t.id === activeId && styles.tabActive,
                !t.isRunning && styles.tabDead,
              )}
              onClick={() => setActiveTerminal(t.id)}
            >
              <span>Terminal {i + 1}</span>
              <button
                type="button"
                className={styles.tabClose}
                onClick={(e) => handleCloseTab(e, t.id)}
                aria-label={`Close Terminal ${i + 1}`}
              >
                <Dismiss12Regular />
              </button>
            </button>
          ))}
          <button type="button" className={styles.addBtn} onClick={handleNewTab} aria-label="New terminal" title="New terminal">
            <Add20Regular style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <IconButton
          aria-label="Close"
          onClick={closeConsole}
          size="md"
          icon={<Dismiss20Regular />}
          className={styles.closeBtn}
        />
      </div>
      <div className={styles.xtermWrap}>
        {terminals.map((t) => (
          <div key={t.id} className={mergeClasses(styles.xtermPane, t.id !== activeId && styles.xtermPaneHidden)}>
            <ConsoleXterm terminal={t} />
          </div>
        ))}
      </div>
    </div>
  );
});
ConsoleStarted.displayName = 'ConsoleStarted';
