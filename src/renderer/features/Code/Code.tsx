import { makeStyles } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { $initialized } from '@/renderer/services/store';

import { CodeDeck } from './CodeDeck';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
});

export const Code = memo(() => {
  const styles = useStyles();
  const initialized = useStore($initialized);
  if (!initialized) {
    return null;
  }

  return (
    <div className={styles.root}>
      <CodeDeck />
    </div>
  );
});
Code.displayName = 'Code';
