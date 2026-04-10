import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';
import { ArrowCounterclockwise20Regular, ChevronDown20Regular, Dismiss20Regular } from '@fluentui/react-icons';

import { Divider, IconButton } from '@/renderer/ds';
import { ConsoleXterm } from '@/renderer/features/Console/ConsoleXterm';
import { $isConsoleOpen, destroyTerminal, type TerminalState } from '@/renderer/features/Console/state';
import { useNewTerminal } from '@/renderer/features/Console/use-new-terminal';

const useStyles = makeStyles({
  root: { display: 'flex', width: '100%', height: '100%', position: 'relative', flexDirection: 'column', minHeight: 0 },
  toolbar: {
    display: 'flex',
    width: '100%',
    height: '48px',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    '@media (min-width: 640px)': { height: '40px' },
  },
  spacer: { flex: '1 1 0' },
  title: {
    color: tokens.colorNeutralForeground3,
    userSelect: 'none',
    fontSize: tokens.fontSizeBase400,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase300 },
  },
  xtermWrap: { width: '100%', height: '100%', padding: tokens.spacingHorizontalS, minHeight: 0 },
  killBtn: { color: tokens.colorPaletteRedForeground1, ':hover': { backgroundColor: 'rgba(248, 113, 113, 0.1)' } },
});

type Props = {
  terminal: TerminalState;
};

const closeConsole = () => {
  $isConsoleOpen.set(false);
};

export const ConsoleStarted = memo(({ terminal }: Props) => {
  const styles = useStyles();
  const newTerminal = useNewTerminal();
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <IconButton
          aria-label="Kill Console"
          onClick={destroyTerminal}
          size="md"
          icon={<Dismiss20Regular />}
          className={styles.killBtn}
        />
        <div className={styles.spacer} />
        <span className={styles.title}>Dev Console</span>
        <div className={styles.spacer} />
        <IconButton
          aria-label="Restart Console"
          onClick={newTerminal}
          size="md"
          icon={<ArrowCounterclockwise20Regular />}
        />
        <IconButton aria-label="Hide Console" onClick={closeConsole} size="md" icon={<ChevronDown20Regular />} />
      </div>
      <Divider />
      <div className={styles.xtermWrap}>
        <ConsoleXterm terminal={terminal} />
      </div>
    </div>
  );
});
ConsoleStarted.displayName = 'ConsoleStarted';
