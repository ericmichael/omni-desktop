import { makeStyles } from '@fluentui/react-components';
import { memo, useCallback, useState } from 'react';

import { Body1, Button, Caption1, MessageBar, MessageBarBody, Spinner } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';

type Props = {
  onBack: () => void;
  onFinish: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '24px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  body: { display: 'flex', flexDirection: 'column', gap: '12px' },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingValidationStep = memo(({ onBack, onFinish }: Props) => {
  const styles = useStyles();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; output: string } | null>(null);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await emitter.invoke('util:test-model-connection');
      setTestResult(result);
    } catch {
      setTestResult({ success: false, output: 'Failed to run connection test' });
    } finally {
      setTesting(false);
    }
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1 weight="semibold">Configuration saved</Body1>
        <Caption1>
          Your model configuration has been written. You can optionally test the connection before continuing.
        </Caption1>
      </div>

      <div className={styles.body}>
        <Button variant="ghost" size="sm" onClick={handleTest} isDisabled={testing}>
          {testing ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner size="sm" />
              Testing connection…
            </span>
          ) : (
            'Test connection'
          )}
        </Button>

        {testResult && (
          <MessageBar intent={testResult.success ? 'success' : 'error'}>
            <MessageBarBody>{testResult.output}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" size="sm" onClick={onFinish}>
          {testResult?.success === false ? 'Continue anyway' : 'Finish setup'}
        </Button>
      </div>
    </div>
  );
});
OnboardingValidationStep.displayName = 'OnboardingValidationStep';
