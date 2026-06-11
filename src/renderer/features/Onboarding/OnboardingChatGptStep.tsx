import { makeStyles, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { buildCodexConfig } from '@/lib/provider-config';
import { Body1Strong, Button, Caption1, Spinner } from '@/renderer/ds';
import { agentConfigApi } from '@/renderer/services/config';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { CodexDeviceCode } from '@/shared/types';

type Props = {
  /** Called with the model that became the default (undefined → Codex available, default untouched). */
  onConnected: (defaultModel: string | undefined) => void;
  onBack: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  codeBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '14px 16px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  codeText: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.12em',
  },
  pendingRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', justifyContent: 'space-between' },
});

export const OnboardingChatGptStep = memo(({ onConnected, onBack }: Props) => {
  const styles = useStyles();
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
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Sign in with ChatGPT</Body1Strong>
        <Caption1>Use your ChatGPT Plus, Pro, or Team subscription — no API key needed.</Caption1>
      </div>

      {busy && deviceCode ? (
        <div className={styles.codeBox}>
          <Caption1>
            Open{' '}
            <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
              {deviceCode.verificationUri}
            </a>{' '}
            and enter this code:
          </Caption1>
          <span className={styles.codeText}>{deviceCode.userCode}</span>
          <div className={styles.pendingRow}>
            <Spinner size="sm" />
            <Caption1>Waiting for you to authorize…</Caption1>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="primary" size="sm" onClick={handleSignIn} isDisabled={busy}>
            {busy ? 'Starting sign-in…' : 'Sign in with ChatGPT'}
          </Button>
        </div>
      )}

      {error && <span className={styles.error}>{error}</span>}

      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onBack} isDisabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
});
OnboardingChatGptStep.displayName = 'OnboardingChatGptStep';
