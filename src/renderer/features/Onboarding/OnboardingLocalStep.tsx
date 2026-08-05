import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { probeFailureCopy } from '@/renderer/features/Onboarding/probe-copy';
import { emitter } from '@/renderer/services/ipc';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

type Props = {
  /** kind: 'ollama' (default port found) or 'openai-compatible' (custom URL). */
  onDetected: (kind: 'ollama' | 'openai-compatible', baseUrl: string, models: string[]) => void;
  onBack: () => void;
};

export const OnboardingLocalStep = memo(({ onDetected, onBack }: Props) => {
  const [probing, setProbing] = useState(true);
  const [customUrl, setCustomUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const probedOnce = useRef(false);

  const probeOllama = useCallback(async (): Promise<boolean> => {
    const result = await emitter
      .invoke('util:validate-provider', { kind: 'ollama', baseUrl: OLLAMA_DEFAULT_URL })
      .catch(() => null);
    if (result?.ok && result.models.length > 0) {
      onDetected('ollama', OLLAMA_DEFAULT_URL, result.models);
      return true;
    }
    return false;
  }, [onDetected]);

  useEffect(() => {
    if (probedOnce.current) {
      return;
    }
    probedOnce.current = true;
    void probeOllama().finally(() => setProbing(false));
  }, [probeOllama]);

  const handleRetry = useCallback(async () => {
    setProbing(true);
    setError(null);
    const found = await probeOllama();
    setProbing(false);
    if (!found) {
      setError('Still no local server on the usual Ollama port. Is it running?');
    }
  }, [probeOllama]);

  const handleCustomUrlChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomUrl(e.target.value);
    setError(null);
  }, []);

  const handleConnectCustom = useCallback(async () => {
    const baseUrl = customUrl.trim();
    if (!baseUrl || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await emitter.invoke('util:validate-provider', { kind: 'openai-compatible', baseUrl });
      if (result.ok) {
        onDetected('openai-compatible', baseUrl, result.models);
      } else {
        setError(probeFailureCopy('your local server', result));
      }
    } catch {
      setError("Couldn't reach that address — check the server is running.");
    } finally {
      setBusy(false);
    }
  }, [customUrl, busy, onDetected]);

  if (probing) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner />
          <span className="text-xs text-muted-foreground">Looking for models on this computer…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">No local models found yet</span>
        <span className="text-xs text-muted-foreground">
          The easiest way to run models on this computer is{' '}
          <a href="https://ollama.com" target="_blank" rel="noopener noreferrer">
            Ollama
          </a>{' '}
          — install it, download a model, then retry.
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3.5 py-3 rounded-xl border border-dashed border-border text-muted-foreground">
        <span className="text-xs text-muted-foreground">
          Already running something else (vLLM, LM Studio)? Enter its address:
        </span>
        <div className="flex flex-col gap-1.5">
          <Input
            value={customUrl}
            onChange={handleCustomUrlChange}
            placeholder="http://localhost:1234"
            disabled={busy}
          />

          <span className="text-xs text-muted-foreground">The address your local server prints when it starts.</span>
        </div>
        <div>
          <Button variant="ghost" size="sm" onClick={handleConnectCustom} disabled={!customUrl.trim() || busy}>
            {busy ? 'Checking…' : 'Connect'}
          </Button>
        </div>
      </div>

      {error && <span className="text-destructive text-xs">{error}</span>}

      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="default" size="sm" onClick={handleRetry} disabled={busy}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
});
OnboardingLocalStep.displayName = 'OnboardingLocalStep';
