/**
 * "Remote backend" card for Settings → General: links the desktop app to a
 * backend other than local Electron main. Two link kinds share the card:
 *
 * - **Cloud** — a deployed launcher (server mode) so chat sessions, projects,
 *   tickets etc. live in the cloud's Postgres and sync across devices. The
 *   flow: enter the launcher URL → ``cloud:link`` discovers the AAD tenant +
 *   client id via ``/.well-known/omni-cloud``, runs the device-code flow, and
 *   persists the tokens + the remoteBackend flag.
 * - **WSL** (Windows only) — the same server build running as a daemon inside
 *   a WSL distro, where Docker and the sandboxes are Linux-native.
 *   ``wsl:link`` provisions the payload into the chosen distro and persists
 *   the flag.
 *
 * Both flows end with main relaunching the app so the renderer transport
 * switches at boot; both disconnect through the shared ``cloud:unlink`` path.
 *
 * Electron-only (linking is meaningless in server mode — the web app IS the
 * remote client). The card hides itself on the browser build.
 */

import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, FormField, Input, Select, Spinner } from '@/renderer/ds';
import { MachineIdentityChip } from '@/renderer/features/SettingsModal/MachineIdentityChip';
import { bootstrapPlatform, ipc, isElectron, isWslLinked, localEmitter } from '@/renderer/services/ipc';
import type { CloudDeviceCode, CloudStatus, WslBackendStatus, WslDetectResult } from '@/shared/types';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
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
  mono: { fontFamily: tokens.fontFamilyMonospace },
});

type WslStatusLine = { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' };

/** Map the daemon + Docker state to a single friendly status line. */
const wslStatusLine = (status: WslBackendStatus | null): WslStatusLine => {
  if (!status) {
    return { text: 'Checking backend status…', tone: 'muted' };
  }
  if (status.state === 'error') {
    return { text: status.error ?? 'The WSL backend hit an error', tone: 'error' };
  }
  if (status.state === 'provisioning') {
    return { text: 'Installing backend…', tone: 'muted' };
  }
  if (status.state === 'starting') {
    return { text: 'Starting…', tone: 'muted' };
  }
  if (status.docker === 'missing') {
    return {
      text: `Docker not found in ${status.distro ?? 'the distro'} — enable Docker Desktop's WSL integration for this distro, or install docker-ce`,
      tone: 'warn',
    };
  }
  if (status.docker === 'daemon-down') {
    return { text: 'Docker is installed but not running', tone: 'warn' };
  }
  if (status.state === 'running') {
    return { text: 'Running — Docker available', tone: 'ok' };
  }
  return { text: 'Checking backend status…', tone: 'muted' };
};

const WSL_STATUS_POLL_MS = 5000;

// Decision 8 (windows-wsl-backend-plan.md): no data migration between the
// Windows-local and WSL data worlds — say so up front.
const FRESH_DATA_ROOT_NOTE =
  'Switching starts a fresh backend data root inside the distro — existing local data stays on Windows and is not migrated.';

export const RemoteBackendCard = memo(() => {
  const styles = useStyles();

  const [url, setUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<CloudDeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  // Link state is a LOCAL-main concept (the `remoteBackend` electron-store
  // flag). It must NOT be read from `persistedStoreApi`/`$store` — in remote-
  // linked mode that mirror reflects the BACKEND's store, which has no
  // `remoteBackend`, so the card would always look disconnected and the
  // Disconnect button would never render. Ask local main directly via
  // `cloud:status` (which reports disconnected for the wsl kind).
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  useEffect(() => {
    void localEmitter.invoke('cloud:status').then(setCloudStatus);
  }, []);
  const cloudMode = cloudStatus?.connected ? cloudStatus : null;

  // Main process emits the AAD device code mid-flow; show it while polling.
  useEffect(() => ipc.on('cloud:device-code', setDeviceCode), []);

  // ── WSL-linked: live daemon + Docker status, polled while visible ──
  const [wslStatus, setWslStatus] = useState<WslBackendStatus | null>(null);
  useEffect(() => {
    if (!isWslLinked) {
      return undefined;
    }
    const poll = (): void => {
      void localEmitter
        .invoke('wsl:status')
        .then(setWslStatus)
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, WSL_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // ── Not linked, on Windows: offer running the backend in WSL ──
  const showWslSection = isElectron && bootstrapPlatform === 'win32' && !isWslLinked;
  const [wslDetect, setWslDetect] = useState<WslDetectResult | null>(null);
  const [wslDistro, setWslDistro] = useState('');
  const [wslLinking, setWslLinking] = useState(false);
  const [wslError, setWslError] = useState<string | null>(null);
  useEffect(() => {
    if (!showWslSection) {
      return;
    }
    void localEmitter
      .invoke('wsl:detect')
      .then((result) => {
        setWslDetect(result);
        if (result.wsl === 'ok') {
          const preferred = result.distros.find((d) => d.isDefault) ?? result.distros[0];
          setWslDistro(preferred?.name ?? '');
        }
      })
      .catch(() => undefined);
  }, [showWslSection]);

  const onConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setDeviceCode(null);
    try {
      // cloud:link / cloud:unlink are handled in LOCAL main (they mutate the
      // electron-store remoteBackend flag + secret store). They must NOT route
      // over the backend WS — once linked, `emitter` points at the backend, so
      // an unlink sent there would never reach local main. Always use `localEmitter`.
      await localEmitter.invoke('cloud:link', url);
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

  // Shared disconnect path for BOTH kinds — main clears the flag and relaunches.
  const onDisconnect = useCallback(async () => {
    setError(null);
    try {
      await localEmitter.invoke('cloud:unlink');
      setRestarting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    }
  }, []);

  const onWslDistroChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setWslDistro(e.target.value);
  }, []);

  const onWslLink = useCallback(async () => {
    setWslLinking(true);
    setWslError(null);
    try {
      // wsl:link provisions the daemon payload into the distro, persists the
      // remoteBackend flag, and relaunches — same restart affordance as cloud.
      await localEmitter.invoke('wsl:link', wslDistro);
      setRestarting(true);
    } catch (e) {
      setWslError(e instanceof Error ? e.message : 'Failed to set up the WSL backend');
    } finally {
      setWslLinking(false);
    }
  }, [wslDistro]);

  // Remote-backend linking is an Electron-only flow — the web client IS the
  // remote client. Hide in server/browser mode rather than rendering a
  // confusing no-op control.
  if (!isElectron) {
    return null;
  }

  if (isWslLinked) {
    const statusLine = wslStatusLine(wslStatus);
    const statusClass =
      statusLine.tone === 'error'
        ? styles.error
        : statusLine.tone === 'warn'
          ? styles.warn
          : statusLine.tone === 'ok'
            ? styles.ok
            : styles.summary;
    return (
      <Card>
        <div className={styles.card}>
          <div className={styles.row}>
            <div className={styles.main}>
              <Body1>{`Backend running in WSL${wslStatus?.distro ? ` (${wslStatus.distro})` : ''}`}</Body1>
              <Caption1 className={error ? styles.error : statusClass}>{error ?? statusLine.text}</Caption1>
            </div>
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
          {restarting && <Caption1 className={styles.ok}>Restarting Omni Code…</Caption1>}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className={styles.card}>
        <div className={styles.row}>
          <div className={styles.main}>
            <Body1>
              {cloudMode ? `Connected to ${cloudMode.url}` : 'Connect this desktop app to a cloud launcher'}
            </Body1>
            <Caption1 className={error ? styles.error : styles.summary}>
              {error ??
                (cloudMode
                  ? `Signed in as ${cloudMode.account.name ?? cloudMode.account.email ?? cloudMode.account.oid} · sessions sync to the cloud Postgres`
                  : 'Sign in with Microsoft Entra ID to sync your chat sessions, projects, and tasks with the deployed launcher (and the web UI).')}
            </Caption1>
            {/* The chip is how the cloud identifies this device — surface it
                regardless of link state so the user knows their machine id
                before connecting and can verify it's stable across reboots. */}
            <div style={{ marginTop: 6 }}>
              <MachineIdentityChip />
            </div>
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

        {!cloudMode && showWslSection && (
          <div className={styles.form}>
            <div className={styles.main}>
              <Body1>Or run the backend in WSL</Body1>
              <Caption1 className={styles.summary}>
                Sandboxes run natively in Linux — Docker, terminals, and agents live inside the distro.
              </Caption1>
            </div>
            {wslDetect?.wsl === 'missing' ? (
              <Caption1 className={styles.summary}>
                WSL 2 not detected — install it with <span className={styles.mono}>wsl --install</span>
              </Caption1>
            ) : (
              <>
                <FormField label="WSL distro">
                  <Select size="sm" value={wslDistro} onChange={onWslDistroChange} disabled={wslLinking || !wslDetect}>
                    {wslDetect?.wsl === 'ok' &&
                      wslDetect.distros.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.isDefault ? `${d.name} (default)` : d.name}
                        </option>
                      ))}
                  </Select>
                </FormField>
                <Caption1 className={wslError ? styles.error : styles.summary}>
                  {wslError ?? FRESH_DATA_ROOT_NOTE}
                </Caption1>
                <div>
                  <Button size="sm" onClick={onWslLink} isDisabled={wslLinking || !wslDistro}>
                    {wslLinking ? 'Setting up…' : 'Run backend in WSL'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {restarting && <Caption1 className={styles.ok}>Restarting Omni Code…</Caption1>}
      </div>
    </Card>
  );
});
RemoteBackendCard.displayName = 'RemoteBackendCard';
