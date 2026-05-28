/**
 * "Connect to Cloud" card for Settings → General.
 *
 * Links the desktop app to a deployed launcher (server mode) so chat
 * sessions, projects, tickets etc. live in the cloud's Postgres and sync
 * across devices / between the Electron app and the web UI. The flow:
 *
 *   1. User enters the launcher URL.
 *   2. ``cloud:link`` fetches ``/.well-known/omni-cloud`` to discover the
 *      AAD tenant + client id, runs the device-code flow, persists the
 *      tokens via {@link ElectronSecretStore} and the cloudMode flag in the
 *      store.
 *   3. Card prompts the user to restart the app so the renderer transport
 *      switches to the cloud variant at boot.
 *
 * Electron-only (cloud-linking is meaningless in server mode — the web
 * app IS the cloud client). The card hides itself on the browser build.
 */

import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, FormField, Input, Spinner } from '@/renderer/ds';
import { emitter, ipc, isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CloudDeviceCode } from '@/shared/types';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
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

export const ConnectCloudCard = memo(() => {
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const cloudMode = storeData.cloudMode;

  const [url, setUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<CloudDeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  // Main process emits the AAD device code mid-flow; show it while polling.
  useEffect(() => ipc.on('cloud:device-code', setDeviceCode), []);

  const onConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setDeviceCode(null);
    try {
      await emitter.invoke('cloud:link', url);
      // Main relaunches the app on a short delay; show a transient message
      // so the user knows what's happening when the window blanks.
      setRestarting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cloud sign-in failed');
    } finally {
      setConnecting(false);
      setDeviceCode(null);
    }
  }, [url]);

  const onDisconnect = useCallback(async () => {
    setError(null);
    try {
      await emitter.invoke('cloud:unlink');
      setRestarting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    }
  }, []);

  // Cloud linking is an Electron-only flow — the web client IS the cloud
  // client. Hide in server/browser mode rather than rendering a confusing
  // no-op control.
  if (!isElectron) {
    return null;
  }

  return (
    <Card>
      <div className={styles.card}>
        <div className={styles.row}>
          <div className={styles.main}>
            <Body1>
              {cloudMode
                ? `Connected to ${cloudMode.url}`
                : 'Connect this desktop app to a cloud launcher'}
            </Body1>
            <Caption1 className={error ? styles.error : styles.summary}>
              {error ??
                (cloudMode
                  ? `Signed in as ${cloudMode.account.name ?? cloudMode.account.email ?? cloudMode.account.oid} · sessions sync to the cloud Postgres`
                  : 'Sign in with Microsoft Entra ID to sync your chat sessions, projects, and tickets with the deployed launcher (and the web UI).')}
            </Caption1>
          </div>
          {cloudMode ? (
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>

        {!cloudMode && (
          <div className={styles.form}>
            <FormField label="Launcher URL">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://omni.example.com"
                disabled={connecting}
              />
            </FormField>
            <div>
              <Button size="sm" onClick={onConnect} isDisabled={connecting || !url.trim()}>
                {connecting ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </div>
        )}

        {connecting && deviceCode && (
          <div className={styles.codeBox}>
            <Caption1>
              Open{' '}
              <a
                href={deviceCode.verificationUriComplete ?? deviceCode.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
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

        {restarting && (
          <Caption1 className={styles.ok}>Restarting Omni Code…</Caption1>
        )}
      </div>
    </Card>
  );
});
ConnectCloudCard.displayName = 'ConnectCloudCard';
