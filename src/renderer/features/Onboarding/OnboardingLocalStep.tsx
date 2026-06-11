import { makeStyles, tokens } from '@fluentui/react-components';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Body1Strong, Button, Caption1, Input, Spinner } from '@/renderer/ds';
import { probeFailureCopy } from '@/renderer/features/Onboarding/probe-copy';
import { emitter } from '@/renderer/services/ipc';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

type Props = {
  /** kind: 'ollama' (default port found) or 'openai-compatible' (custom URL). */
  onDetected: (kind: 'ollama' | 'openai-compatible', baseUrl: string, models: string[]) => void;
  onBack: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  probing: { display: 'flex', alignItems: 'center', gap: '8px', color: tokens.colorNeutralForeground2 },
  instructions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px 14px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
  },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', justifyContent: 'space-between' },
  actionsRight: { display: 'flex', gap: '8px' },
});

export const OnboardingLocalStep = memo(({ onDetected, onBack }: Props) => {
  const styles = useStyles();
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
      <div className={styles.root}>
        <div className={styles.probing}>
          <Spinner size="sm" />
          <Caption1>Looking for models on this computer…</Caption1>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>No local models found yet</Body1Strong>
        <Caption1>
          The easiest way to run models on this computer is{' '}
          <a href="https://ollama.com" target="_blank" rel="noopener noreferrer">
            Ollama
          </a>{' '}
          — install it, download a model, then retry.
        </Caption1>
      </div>

      <div className={styles.instructions}>
        <Caption1>Already running something else (vLLM, LM Studio)? Enter its address:</Caption1>
        <div className={styles.field}>
          <Input
            size="sm"
            mono
            value={customUrl}
            onChange={handleCustomUrlChange}
            placeholder="http://localhost:1234"
            disabled={busy}
          />
          <Caption1>The address your local server prints when it starts.</Caption1>
        </div>
        <div>
          <Button variant="ghost" size="sm" onClick={handleConnectCustom} isDisabled={!customUrl.trim() || busy}>
            {busy ? 'Checking…' : 'Connect'}
          </Button>
        </div>
      </div>

      {error && <span className={styles.error}>{error}</span>}

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <div className={styles.actionsRight}>
          <Button variant="primary" size="sm" onClick={handleRetry} isDisabled={busy}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
});
OnboardingLocalStep.displayName = 'OnboardingLocalStep';
