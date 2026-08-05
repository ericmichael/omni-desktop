import { memo, useCallback, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { emitter } from '@/renderer/services/ipc';

type Props = {
  onBack: () => void;
  onFinish: () => void;
};

export const OnboardingValidationStep = memo(({ onBack, onFinish }: Props) => {
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Almost there</span>
        <span className="text-xs text-muted-foreground">
          Your setup is saved. You can give it a quick test before you start.
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing}>
          {testing ? (
            <span className="flex items-center gap-2">
              <Spinner />
              Testing connection…
            </span>
          ) : (
            'Test connection'
          )}
        </Button>

        {testResult && (
          <Alert variant={(testResult.success ? 'success' : 'error') === 'error' ? 'destructive' : 'default'}>
            <AlertDescription>{testResult.output}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button variant="default" size="sm" onClick={onFinish}>
          {testResult?.success === false ? 'Continue anyway' : 'Continue'}
        </Button>
      </div>
    </div>
  );
});
OnboardingValidationStep.displayName = 'OnboardingValidationStep';
