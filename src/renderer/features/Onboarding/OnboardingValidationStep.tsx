import { memo, useCallback, useState } from 'react';

import { Button, Spinner } from '@/renderer/ds';
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
        <h3 className="text-lg font-semibold text-fg">Configuration saved</h3>
        <p className="text-sm text-fg-muted">
          Your model configuration has been written. You can optionally test the connection before continuing.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" onClick={handleTest} isDisabled={testing}>
          {testing ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" />
              Testing connection…
            </span>
          ) : (
            'Test connection'
          )}
        </Button>

        {testResult && (
          <div
            className={`rounded-md border p-3 text-xs font-mono whitespace-pre-wrap ${
              testResult.success
                ? 'border-green-500/30 bg-green-500/10 text-green-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {testResult.output}
          </div>
        )}
      </div>

      <div className="flex justify-between">
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
