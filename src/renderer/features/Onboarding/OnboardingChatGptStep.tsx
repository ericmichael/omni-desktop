import { memo, useCallback, useEffect, useState } from 'react';

import { buildCodexConfig } from '@/lib/provider-config';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { agentConfigApi } from '@/renderer/services/config';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { CodexDeviceCode } from '@/shared/types';

type Props = {
  /** Called with the model that became the default (undefined → Codex available, default untouched). */
  onConnected: (defaultModel: string | undefined) => void;
  onBack: () => void;
};

export const OnboardingChatGptStep = memo(({ onConnected, onBack }: Props) => {
  const [busy, setBusy] = useState(false);
  const [deviceCode, setDeviceCode] = useState<CodexDeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Main pushes the user code mid-flow; show it while codex:link polls.
  useEffect(() => ipc.on('codex:device-code', setDeviceCode), []);

  const handleSignIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    try {
      const status = await emitter.invoke('codex:link');
      if (!status.signedIn) {
        setError("Sign-in didn't complete — try again.");
        return;
      }
      const current = await agentConfigApi.getModels();
      const runtime = await emitter.invoke('util:list-models').catch(() => null);
      const { config, madeDefault } = buildCodexConfig(current, runtime);
      await agentConfigApi.setModels(config);
      onConnected(madeDefault);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
      setDeviceCode(null);
    }
  }, [onConnected]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Sign in with ChatGPT</span>
        <span className="text-xs text-muted-foreground">
          Use your ChatGPT Plus, Pro, or Team subscription — no API key needed.
        </span>
      </div>

      {busy && deviceCode ? (
        <div className="flex flex-col gap-2 px-4 py-3.5 rounded-xl border border-border bg-card">
          <span className="text-xs text-muted-foreground">
            Open{' '}
            <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
              {deviceCode.verificationUri}
            </a>{' '}
            and enter this code:
          </span>
          <span className="font-mono text-2xl font-semibold tracking-widest">{deviceCode.userCode}</span>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-xs text-muted-foreground">Waiting for you to authorize…</span>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="default" size="sm" onClick={handleSignIn} disabled={busy}>
            {busy ? 'Starting sign-in…' : 'Sign in with ChatGPT'}
          </Button>
        </div>
      )}

      {error && <span className="text-destructive text-xs">{error}</span>}

      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
});
OnboardingChatGptStep.displayName = 'OnboardingChatGptStep';
