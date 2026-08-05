/**
 * "Remote backend" card for Settings → General: links the desktop app to a
 * backend other than local Electron main. Three link kinds share the card:
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
 * - **Self-hosted server** — a server-mode launcher the user runs themselves
 *   (homelab, Tailscale, LAN). No Entra: ``server:link`` validates the URL
 *   against ``/api/health`` + ``/api/ws-token`` and persists the flag. The
 *   server must trust this machine's network (``OMNI_TRUSTED_CIDRS``).
 *
 * All flows end with main relaunching the app so the renderer transport
 * switches at boot; all disconnect through the shared ``cloud:unlink`` path.
 *
 * Electron-only (linking is meaningless in server mode — the web app IS the
 * remote client). The card hides itself on the browser build.
 */
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Switch } from '@/renderer/ds/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/renderer/ds/ui/toggle-group';
import { MachineIdentityChip } from '@/renderer/features/SettingsModal/MachineIdentityChip';
import { settingsCardContentClassName } from '@/renderer/features/SettingsModal/SettingsLayout';
import {
  bootstrapPlatform,
  ipc,
  isElectron,
  isServerLinked,
  isWslLinked,
  localEmitter,
  serverOrigin,
} from '@/renderer/services/ipc';
import type { CloudDeviceCode, CloudStatus, WslBackendStatus, WslDetectResult } from '@/shared/types';

type WslStatusLine = { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' };
type BackendSetupMode = 'cloud' | 'wsl' | 'server';

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
  const [setupMode, setSetupMode] = useState<BackendSetupMode>('cloud');
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
  const refreshWslStatus = useCallback(() => {
    void localEmitter
      .invoke('wsl:status')
      .then(setWslStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isWslLinked) {
      return undefined;
    }
    refreshWslStatus();
    const interval = setInterval(refreshWslStatus, WSL_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [refreshWslStatus]);

  // Persistent daemon mode toggle — the flag round-trips through
  // `wsl:set-persistent` (local main restarts the daemon into the new
  // lifecycle) and renders back from `wsl:status` alone.
  const onPersistentChange = useCallback(
    (checked: boolean) => {
      setError(null);
      void localEmitter
        .invoke('wsl:set-persistent', checked)
        .then(refreshWslStatus)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to change the backend mode'));
    },
    [refreshWslStatus]
  );

  // ── Not linked, on Windows: offer running the backend in WSL ──
  const showWslSection = isElectron && bootstrapPlatform === 'win32' && !isWslLinked;
  const [wslDetect, setWslDetect] = useState<WslDetectResult | null>(null);
  const [wslDistro, setWslDistro] = useState('');
  const [wslLinking, setWslLinking] = useState(false);
  const [wslError, setWslError] = useState<string | null>(null);
  // Shared by the mount effect and the post-`wsl:install` refresh, so a
  // freshly registered Ubuntu falls straight into the distro-select flow.
  const refreshWslDetect = useCallback(() => {
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
  }, []);
  useEffect(() => {
    if (!showWslSection) {
      return;
    }
    refreshWslDetect();
  }, [showWslSection, refreshWslDetect]);

  // ── `wsl:install` flows for machines with no usable WSL ──
  const [wslInstalling, setWslInstalling] = useState(false);
  // 'platform' launched: the elevated install is unobservable from here
  // (UAC + likely reboot), so the section swaps to a static what-happens-next
  // note instead of pretending to track progress.
  const [wslInstallStarted, setWslInstallStarted] = useState(false);

  const onWslInstallPlatform = useCallback(async () => {
    setWslInstalling(true);
    setWslError(null);
    try {
      await localEmitter.invoke('wsl:install', 'platform');
      setWslInstallStarted(true);
    } catch {
      // Non-zero powershell exit = declined UAC (or a launch failure) — the
      // raw Start-Process stderr is noise, not guidance.
      setWslError('Installation was cancelled or failed');
    } finally {
      setWslInstalling(false);
    }
  }, []);

  const onWslInstallDistro = useCallback(async () => {
    setWslInstalling(true);
    setWslError(null);
    try {
      await localEmitter.invoke('wsl:install', 'distro');
      refreshWslDetect();
    } catch (e) {
      setWslError(e instanceof Error ? e.message : 'Failed to install Ubuntu');
    } finally {
      setWslInstalling(false);
    }
  }, [refreshWslDetect]);

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

  // ── Not linked: offer connecting to a self-hosted server-mode launcher ──
  const [serverUrl, setServerUrl] = useState('');
  const [serverLinking, setServerLinking] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const onSetupModeChange = useCallback((value: string) => {
    if (value === 'cloud' || value === 'wsl' || value === 'server') {
      setSetupMode(value);
    }
  }, []);

  const onServerConnect = useCallback(async () => {
    setServerLinking(true);
    setServerError(null);
    try {
      // server:link validates /api/health + /api/ws-token in local main (Node
      // fetch, no CORS), persists the remoteBackend flag, and relaunches.
      await localEmitter.invoke('server:link', serverUrl);
      setRestarting(true);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'Failed to connect to the server');
    } finally {
      setServerLinking(false);
    }
  }, [serverUrl]);

  // Remote-backend linking is an Electron-only flow — the web client IS the
  // remote client. Hide in server/browser mode rather than rendering a
  // confusing no-op control.
  if (!isElectron) {
    return null;
  }

  if (isServerLinked) {
    // No account line — a self-hosted link carries no identity; the server
    // trusts this machine by network address.
    return (
      <Card>
        <CardContent className={settingsCardContentClassName}>
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm">{`Connected to ${serverOrigin()} (self-hosted)`}</span>
              <span
                className={cn('text-xs text-muted-foreground', error ? 'text-destructive' : 'text-muted-foreground')}
              >
                {error ?? 'Sessions, projects, and tasks live on your server'}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
          {restarting && (
            <span className={cn('text-xs text-muted-foreground', 'text-success')}>Restarting Omni Code…</span>
          )}
        </CardContent>
      </Card>
    );
  }

  if (isWslLinked) {
    const statusLine = wslStatusLine(wslStatus);
    const statusClass =
      statusLine.tone === 'error'
        ? 'text-destructive'
        : statusLine.tone === 'warn'
          ? 'text-warning'
          : statusLine.tone === 'ok'
            ? 'text-success'
            : 'text-muted-foreground';
    // Freeze the toggle while the daemon is mid-transition — a second restart
    // on top of a provision/spawn in flight would race the first.
    const wslBusy = wslStatus?.state === 'provisioning' || wslStatus?.state === 'starting';
    return (
      <Card>
        <CardContent className={settingsCardContentClassName}>
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm">{`Backend running in WSL${wslStatus?.distro ? ` (${wslStatus.distro})` : ''}`}</span>
              <span className={cn('text-xs text-muted-foreground', error ? 'text-destructive' : statusClass)}>
                {error ?? statusLine.text}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm">Keep backend running when the app is closed</span>
              <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                Changing this restarts the backend daemon — active sessions reconnect, but agent work running in the
                daemon is interrupted.
              </span>
            </div>
            <Switch checked={wslStatus?.persistent === true} onCheckedChange={onPersistentChange} disabled={wslBusy} />
          </div>
          {restarting && (
            <span className={cn('text-xs text-muted-foreground', 'text-success')}>Restarting Omni Code…</span>
          )}
        </CardContent>
      </Card>
    );
  }

  if (cloudMode) {
    return (
      <Card>
        <CardContent className={settingsCardContentClassName}>
          <div className="flex items-center gap-4">
            <FieldContent>
              <FieldLabel>{`Connected to ${cloudMode.url}`}</FieldLabel>
              <FieldDescription>
                {error ?? `Signed in as ${cloudMode.account.name ?? cloudMode.account.email ?? cloudMode.account.oid}`}
              </FieldDescription>
            </FieldContent>
            <Button size="sm" variant="outline" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
          {restarting && (
            <span className={cn('text-xs text-muted-foreground', 'text-success')}>Restarting Omni Code…</span>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className={settingsCardContentClassName}>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={setupMode}
          onValueChange={onSetupModeChange}
          aria-label="Backend connection type"
        >
          <ToggleGroupItem value="cloud">Cloud</ToggleGroupItem>
          {showWslSection && <ToggleGroupItem value="wsl">WSL</ToggleGroupItem>}
          <ToggleGroupItem value="server">Self-hosted</ToggleGroupItem>
        </ToggleGroup>

        {setupMode === 'cloud' && (
          <div className="flex flex-col gap-5">
            <FieldContent>
              <FieldLabel>Cloud launcher</FieldLabel>
              <FieldDescription>Sign in to sync your work across the desktop and web apps.</FieldDescription>
            </FieldContent>
            <Field orientation="horizontal" className="justify-between gap-4">
              <FieldLabel>Launcher URL</FieldLabel>
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://omni.example.com"
                disabled={connecting}
              />
            </Field>
            <div className="flex items-center justify-between gap-4">
              <MachineIdentityChip />
              <Button size="sm" onClick={onConnect} disabled={connecting || !url.trim()}>
                {connecting ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
            {error && <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{error}</span>}
            {connecting && deviceCode && (
              <div className="flex flex-col gap-0.5 p-2 rounded-lg bg-background border border-border">
                <span className="text-xs text-muted-foreground">
                  Open{' '}
                  <a
                    href={deviceCode.verificationUriComplete ?? deviceCode.verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {deviceCode.verificationUri}
                  </a>{' '}
                  and enter this code:
                </span>
                <span className="font-mono text-xl font-semibold tracking-widest">{deviceCode.userCode}</span>
                <div className="flex items-center gap-2">
                  <Spinner />
                  <span className="text-xs text-muted-foreground">Waiting for authorization…</span>
                </div>
              </div>
            )}
          </div>
        )}

        {setupMode === 'wsl' && showWslSection && (
          <div className="flex flex-col gap-5">
            <FieldContent>
              <FieldLabel>Windows Subsystem for Linux</FieldLabel>
              <FieldDescription>Run sandboxes and agents in a local Linux environment.</FieldDescription>
            </FieldContent>
            {wslDetect?.wsl === 'missing' ? (
              wslInstallStarted ? (
                <span className="text-sm text-muted-foreground">
                  Finish the Windows installation, then return here after restarting if requested.
                </span>
              ) : (
                <div className="flex items-center justify-between gap-4">
                  <span className={cn('text-sm text-muted-foreground', wslError && 'text-destructive')}>
                    {wslError ?? 'WSL 2 is not installed.'}
                  </span>
                  <Button size="sm" onClick={onWslInstallPlatform} disabled={wslInstalling}>
                    {wslInstalling ? 'Installing…' : 'Install WSL 2'}
                  </Button>
                </div>
              )
            ) : wslDetect?.wsl === 'ok' && wslDetect.distros.length === 0 ? (
              <div className="flex items-center justify-between gap-4">
                <span className={cn('text-sm text-muted-foreground', wslError && 'text-destructive')}>
                  {wslError ?? 'Install a Linux distribution to continue.'}
                </span>
                <Button size="sm" onClick={onWslInstallDistro} disabled={wslInstalling}>
                  {wslInstalling ? 'Installing…' : 'Install Ubuntu'}
                </Button>
              </div>
            ) : (
              <>
                <Field orientation="horizontal" className="justify-between gap-4">
                  <FieldLabel>Linux distribution</FieldLabel>
                  <Select value={wslDistro} onChange={onWslDistroChange} disabled={wslLinking || !wslDetect}>
                    {wslDetect?.wsl === 'ok' &&
                      wslDetect.distros.map((distro) => (
                        <option key={distro.name} value={distro.name}>
                          {distro.isDefault ? `${distro.name} (default)` : distro.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <div className="flex items-center justify-between gap-4">
                  <span className={cn('text-xs text-muted-foreground', wslError && 'text-destructive')}>
                    {wslError ?? FRESH_DATA_ROOT_NOTE}
                  </span>
                  <Button size="sm" onClick={onWslLink} disabled={wslLinking || !wslDistro}>
                    {wslLinking ? 'Setting up…' : 'Use WSL'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {setupMode === 'server' && (
          <div className="flex flex-col gap-5">
            <FieldContent>
              <FieldLabel>Self-hosted server</FieldLabel>
              <FieldDescription>Connect to a launcher server you manage. No account is required.</FieldDescription>
            </FieldContent>
            <Field orientation="horizontal" className="justify-between gap-4">
              <FieldLabel>Server URL</FieldLabel>
              <Input
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="http://my-server:3001"
                disabled={serverLinking}
              />
            </Field>
            <div className="flex items-center justify-between gap-4">
              <span className={cn('text-xs text-muted-foreground', serverError && 'text-destructive')}>
                {serverError ?? 'The server must allow connections from this computer.'}
              </span>
              <Button size="sm" onClick={onServerConnect} disabled={serverLinking || !serverUrl.trim()}>
                {serverLinking ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </div>
        )}

        {restarting && (
          <span className={cn('text-xs text-muted-foreground', 'text-success')}>Restarting Omni Code…</span>
        )}
      </CardContent>
    </Card>
  );
});
RemoteBackendCard.displayName = 'RemoteBackendCard';
