import { CircleCheck } from 'lucide-react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { probeFailureCopy } from '@/renderer/features/Onboarding/probe-copy';
import { emitter } from '@/renderer/services/ipc';

type Props = {
  kind: 'openai' | 'anthropic';
  onValidated: (apiKey: string, models: string[]) => void;
  onBack: () => void;
  onAdvanced: () => void;
};

const PROVIDER_COPY: Record<Props['kind'], { label: string; keyHint: string; keyUrl: string }> = {
  openai: {
    label: 'OpenAI',
    keyHint: 'Find or create a key at platform.openai.com/api-keys',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    keyHint: 'Find or create a key at console.anthropic.com/settings/keys',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
};

export const OnboardingKeyEntryStep = memo(({ kind, onValidated, onBack, onAdvanced }: Props) => {
  const copy = PROVIDER_COPY[kind];
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);

  const handleKeyChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
    setError(null);
    setValidated(false);
  }, []);

  const handleContinue = useCallback(async () => {
    const key = apiKey.trim();
    if (!key || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await emitter.invoke('util:validate-provider', { kind, apiKey: key });
      if (result.ok) {
        setValidated(true);
        onValidated(key, result.models);
      } else {
        setFailCount((n) => n + 1);
        setError(probeFailureCopy(copy.label, result));
      }
    } catch {
      setFailCount((n) => n + 1);
      setError(`Couldn't reach ${copy.label} — check your internet connection and try again.`);
    } finally {
      setBusy(false);
    }
  }, [apiKey, busy, kind, copy.label, onValidated]);

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        void handleContinue();
      }
    },
    [handleContinue]
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Connect your {copy.label} account</span>
        <span className="text-xs text-muted-foreground">
          Paste your API key — we check it instantly, and it never leaves this machine.{' '}
          <a href={copy.keyUrl} target="_blank" rel="noopener noreferrer">
            {copy.keyHint}
          </a>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">API key</span>
        <div className="flex items-center gap-2">
          <div className="flex-auto min-w-0">
            <Input
              type="password"
              value={apiKey}
              onChange={handleKeyChange}
              onKeyDown={handleInputKeyDown}
              placeholder={kind === 'openai' ? 'sk-…' : 'sk-ant-…'}
              autoFocus
              disabled={busy}
            />
          </div>
          {busy && <Spinner />}
          {validated && <CircleCheck className="shrink-0 text-success" />}
        </div>
        {error && <span className="text-destructive text-xs">{error}</span>}
        {failCount >= 2 && (
          <div className="mt-1">
            <Button variant="ghost" size="sm" onClick={onAdvanced}>
              Set up manually instead
            </Button>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button variant="default" size="sm" onClick={handleContinue} disabled={!apiKey.trim() || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
});
OnboardingKeyEntryStep.displayName = 'OnboardingKeyEntryStep';
