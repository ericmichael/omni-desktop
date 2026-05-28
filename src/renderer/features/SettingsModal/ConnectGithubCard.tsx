/**
 * "Connect GitHub" card for Settings → Git. Linking runs the OAuth device flow
 * in the main process; this card displays the user code (pushed via the
 * `github:device-code` event) while it polls, then shows the connected account.
 *
 * Connecting also populates the `github.com` git credential, so once linked the
 * credential list shows it and private clone/push work — no manual PAT needed.
 */
import { Avatar, makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, Spinner } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GithubDeviceCode } from '@/shared/types';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  codeBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.1em',
  },
  pending: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export const ConnectGithubCard = memo(() => {
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const account = storeData.githubAccount;

  const [connecting, setConnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<GithubDeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The main process emits the user code mid-flow; show it while we poll.
  useEffect(() => ipc.on('github:device-code', setDeviceCode), []);

  const onConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setDeviceCode(null);
    try {
      await emitter.invoke('github:link');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'GitHub linking failed');
    } finally {
      setConnecting(false);
      setDeviceCode(null);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    setError(null);
    try {
      await emitter.invoke('github:unlink');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    }
  }, []);

  return (
    <Card>
      <div className={styles.card}>
        <div className={styles.row}>
          {account && <Avatar name={account.login} image={{ src: account.avatarUrl }} size={36} />}
          <div className={styles.main}>
            <Body1>{account ? `Connected as @${account.login}` : 'Connect your GitHub account'}</Body1>
            <Caption1 className={error ? styles.error : styles.summary}>
              {error ??
                (account
                  ? `${account.host} · clone/push private repos and pick from your repositories`
                  : 'Authenticate once to clone private repos and pick sources from a list — no token to paste.')}
            </Caption1>
          </div>
          {account ? (
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} isDisabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect GitHub'}
            </Button>
          )}
        </div>

        {connecting && deviceCode && (
          <div className={styles.codeBox}>
            <Caption1>
              Open{' '}
              <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
                {deviceCode.verificationUri}
              </a>{' '}
              and enter this code:
            </Caption1>
            <span className={styles.code}>{deviceCode.userCode}</span>
            <div className={styles.pending}>
              <Spinner size="sm" />
              <Caption1>Waiting for authorization…</Caption1>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
});
ConnectGithubCard.displayName = 'ConnectGithubCard';
