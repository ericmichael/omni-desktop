import {
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { memo } from 'react';

import { Button } from '@/renderer/ds/Button';

type SaveBarProps = {
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  error?: string | null;
};

const useStyles = makeStyles({
  root: {
    marginTop: '4px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export const SaveBar = memo(({ onSave, dirty, saving, error }: SaveBarProps) => {
  const styles = useStyles();

  if (!dirty && !error && !saving) return null;

  return (
    <div className={styles.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <MessageBar intent={dirty ? 'warning' : 'info'}>
        <MessageBarBody>{saving ? 'Saving\u2026' : 'Unsaved changes'}</MessageBarBody>
        <MessageBarActions>
          <Button variant="primary" size="sm" onClick={onSave} isDisabled={!dirty || saving}>
            {saving ? 'Saving\u2026' : 'Save'}
          </Button>
        </MessageBarActions>
      </MessageBar>
    </div>
  );
});
SaveBar.displayName = 'SaveBar';
