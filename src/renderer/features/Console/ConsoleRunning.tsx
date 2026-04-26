import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { Add20Regular, Dismiss12Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { ConsoleXterm } from '@/renderer/features/Console/ConsoleXterm';
import type { TerminalState } from '@/renderer/features/Console/state';
import {
  $activeTerminalIdByTab,
  $terminalsByTab,
  createTerminal,
  destroyTerminal,
  ensureTerminalForTab,
  setActiveTerminal,
} from '@/renderer/features/Console/state';

const useStyles = makeStyles({
  root: { display: 'flex', width: '100%', height: '100%', position: 'relative', flexDirection: 'column', minHeight: 0 },
  toolbar: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    minHeight: '44px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: '0',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
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
    gap: '6px',
    minHeight: '30px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '4px',
    paddingBottom: '6px',
    borderTopLeftRadius: tokens.borderRadiusMedium,
    borderTopRightRadius: tokens.borderRadiusMedium,
    borderBottomLeftRadius: '0',
    borderBottomRightRadius: '0',
    border: '1px solid transparent',
    borderBottomWidth: '0',
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
    borderTopColor: tokens.colorNeutralStroke1,
    borderLeftColor: tokens.colorNeutralStroke1,
    borderRightColor: tokens.colorNeutralStroke1,
    marginBottom: '-1px',
  },
  tabDead: {
    color: tokens.colorPaletteRedForeground1,
  },
  tabClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: '2px',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  addBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
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
  xtermWrap: { position: 'relative', width: '100%', height: '100%', minHeight: 0 },
  xtermPane: { position: 'absolute', inset: 0 },
  xtermPaneHidden: { display: 'none' },
});

type TerminalTabButtonProps = {
  tabId: string;
  terminalId: string;
  label: string;
  className: string;
  closeClassName: string;
};

const TerminalTabButton = memo(
  ({ tabId, terminalId, label, className, closeClassName }: TerminalTabButtonProps) => {
    const handleActivate = useCallback(() => {
      setActiveTerminal(tabId, terminalId);
    }, [tabId, terminalId]);

    const handleClose = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        void destroyTerminal(tabId, terminalId);
      },
      [tabId, terminalId]
    );

    return (
      <button type="button" className={className} onClick={handleActivate}>
        <span>{label}</span>
        <button
          type="button"
          className={closeClassName}
          onClick={handleClose}
          aria-label={`Close ${label}`}
        >
          <Dismiss12Regular />
        </button>
      </button>
    );
  }
);
TerminalTabButton.displayName = 'TerminalTabButton';

type XtermPaneProps = {
  terminal: TerminalState;
  hidden: boolean;
  className: string;
  hiddenClassName: string;
};

const XtermPane = memo(({ terminal, hidden, className, hiddenClassName }: XtermPaneProps) => (
  <div className={mergeClasses(className, hidden && hiddenClassName)}>
    <ConsoleXterm terminal={terminal} />
  </div>
));
XtermPane.displayName = 'XtermPane';

type ConsoleStartedProps = {
  tabId: string;
  /** cwd used when the user hits the + button to open a new terminal in this column. */
  cwd?: string;
};

export const ConsoleStarted = memo(({ tabId, cwd }: ConsoleStartedProps) => {
  const styles = useStyles();
  const terminalsByTab = useStore($terminalsByTab);
  const activeByTab = useStore($activeTerminalIdByTab);
  const terminals = useMemo(() => terminalsByTab[tabId] ?? [], [terminalsByTab, tabId]);
  const activeId = activeByTab[tabId] ?? null;

  useEffect(() => {
    void ensureTerminalForTab(tabId, cwd);
  }, [tabId, cwd]);

  const handleNewTab = useCallback(() => {
    void createTerminal(tabId, cwd);
  }, [tabId, cwd]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {terminals.map((t, i) => (
            <TerminalTabButton
              key={t.id}
              tabId={tabId}
              terminalId={t.id}
              label={`Terminal ${i + 1}`}
              className={mergeClasses(
                styles.tab,
                t.id === activeId && styles.tabActive,
                !t.isRunning && styles.tabDead,
              )}
              closeClassName={styles.tabClose}
            />
          ))}
          <button type="button" className={styles.addBtn} onClick={handleNewTab} aria-label="New terminal" title="New terminal">
            <Add20Regular style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>
      <div className={styles.xtermWrap}>
        {terminals.map((t) => (
          <XtermPane
            key={t.id}
            terminal={t}
            hidden={t.id !== activeId}
            className={styles.xtermPane}
            hiddenClassName={styles.xtermPaneHidden}
          />
        ))}
      </div>
    </div>
  );
});
ConsoleStarted.displayName = 'ConsoleStarted';
