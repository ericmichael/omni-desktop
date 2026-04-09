import { memo, useCallback, useEffect, useState } from 'react';

import { Button, Spinner } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';

type Props = {
  onBack?: (() => void) | undefined;
  onFinish: () => void;
};

export const OnboardingCliStep = memo(({ onBack, onFinish }: Props) => {
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold text-fg">Install the Omni CLI</h3>
        <p className="text-sm text-fg-muted">
          Omni Code also comes as a terminal-based coding agent. Install the{' '}
          <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-fg">omni</code> command to use it
          directly from your terminal.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {installed ? (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-300">
            Installed at {status.symlinkPath}
          </div>
        ) : (
          <Button variant="primary" size="sm" onClick={handleInstall} isDisabled={installing}>
            {installing ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" />
                Installing…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                Install omni to PATH
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium text-white/80">
                  Recommended
                </span>
              </span>
            )}
          </Button>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div>
        )}
      </div>

      <div className={`flex ${onBack ? 'justify-between' : 'justify-end'}`}>
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
