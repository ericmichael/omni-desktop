import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { Strong } from '@/renderer/common/Strong';
import { Button } from '@/renderer/ds';
import { useNewTerminal } from '@/renderer/features/Console/use-new-terminal';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalL,
  },
  hint: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
});

export const ConsoleNotRunning = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const newTerminal = useNewTerminal();
  return (
    <div className={styles.root}>
      <Button variant="link" onClick={newTerminal}>
        Start Dev Console
      </Button>
      {store.workspaceDir && (
        <span className={styles.hint}>
          We&apos;ll open the console in <Strong>{store.workspaceDir}</Strong>.
        </span>
      )}
    </div>
  );
});
ConsoleNotRunning.displayName = 'ConsoleNotRunning';
