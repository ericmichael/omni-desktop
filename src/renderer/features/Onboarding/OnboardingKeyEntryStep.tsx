import { makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Filled } from '@fluentui/react-icons';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useState } from 'react';

import { Body1Strong, Button, Caption1, Input, Spinner } from '@/renderer/ds';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  inputRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  inputWrap: { flex: '1 1 auto', minWidth: 0 },
  statusIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  escape: { marginTop: '4px' },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingKeyEntryStep = memo(({ kind, onValidated, onBack, onAdvanced }: Props) => {
  const styles = useStyles();
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
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Connect your {copy.label} account</Body1Strong>
        <Caption1>
          Paste your API key — we check it instantly, and it never leaves this machine.{' '}
          <a href={copy.keyUrl} target="_blank" rel="noopener noreferrer">
            {copy.keyHint}
          </a>
        </Caption1>
      </div>

      <div className={styles.field}>
        <Caption1>API key</Caption1>
        <div className={styles.inputRow}>
          <div className={styles.inputWrap}>
            <Input
              type="password"
              size="sm"
              value={apiKey}
              onChange={handleKeyChange}
              onKeyDown={handleInputKeyDown}
              placeholder={kind === 'openai' ? 'sk-…' : 'sk-ant-…'}
              autoFocus
              disabled={busy}
            />
          </div>
          {busy && <Spinner size="sm" />}
          {validated && <CheckmarkCircle20Filled className={styles.statusIcon} />}
        </div>
        {error && <span className={styles.error}>{error}</span>}
        {failCount >= 2 && (
          <div className={styles.escape}>
            <Button variant="ghost" size="sm" onClick={onAdvanced}>
              Set up manually instead
            </Button>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onBack} isDisabled={busy}>
          Back
        </Button>
        <Button variant="primary" size="sm" onClick={handleContinue} isDisabled={!apiKey.trim() || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </div>
    </div>
  );
});
OnboardingKeyEntryStep.displayName = 'OnboardingKeyEntryStep';
