import { makeStyles } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, Spinner } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';

type Props = {
  onBack?: (() => void) | undefined;
  onFinish: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '24px' },
  header: { display: 'flex', flexDirection: 'column', gap: '8px' },
  body: { display: 'flex', flexDirection: 'column', gap: '12px' },
  actions: { display: 'flex', justifyContent: 'space-between' },
  actionsEnd: { display: 'flex', justifyContent: 'flex-end' },
});

export const OnboardingCliStep = memo(({ onBack, onFinish }: Props) => {
  const styles = useStyles();
  const [status, setStatus] = useState<{ installed: boolean; symlinkPath: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    const result = await emitter.invoke('util:get-cli-in-path-status');
    setStatus(result);
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      const result = await emitter.invoke('util:install-cli-to-path');
      if (!result.success) {
setError(result.error);
}
      await checkStatus();
    } finally {
      setInstalling(false);
    }
  }, [checkStatus]);

  const installed = status?.installed === true;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1 weight="semibold">Install the Omni CLI</Body1>
        <Caption1>
          Omni Code also comes as a terminal-based coding agent. Install the <code>omni</code> command to use it
          directly from your terminal.
        </Caption1>
      </div>

      <div className={styles.body}>
        {installed ? (
          <MessageBar intent="success">
            <MessageBarBody>Installed at {status.symlinkPath}</MessageBarBody>
          </MessageBar>
        ) : (
          <Button variant="primary" size="sm" onClick={handleInstall} isDisabled={installing}>
            {installing ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Spinner size="sm" />
                Installing…
              </span>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Install omni to PATH
                <Badge appearance="filled" color="brand" size="small">Recommended</Badge>
              </span>
            )}
          </Button>
        )}

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div className={onBack ? styles.actions : styles.actionsEnd}>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={onFinish}>
          {installed ? 'Finish setup' : 'Skip'}
        </Button>
      </div>
    </div>
  );
});
OnboardingCliStep.displayName = 'OnboardingCliStep';
