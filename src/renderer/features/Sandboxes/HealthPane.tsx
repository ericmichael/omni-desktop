/**
 * Sandboxes → Health: is the substrate able to run sandboxes right now?
 *
 * - Docker probe (`sandbox:substrate-status`) — runs backend-side, so on a
 *   WSL/cloud-linked client it reports the daemon's Docker, not Windows'.
 * - WSL daemon row (Windows, WSL-linked only) — fed by polling `wsl:status`
 *   via `localEmitter`; the daemon manager lives in local Electron main.
 *   Docker bootstrap (`wsl:install-docker` / `wsl:start-docker`) is also
 *   localEmitter-only — wsl.exe runs on the Windows side.
 * - Images card (docker `ok` only): presence/size of the devbox image via
 *   `sandbox:image-status`, with pull + prune-dangling actions.
 * - Read-only backend-link summary. Link management stays in Settings
 *   (sandboxes-tab-plan.md Decision 5) — this only deep-links there.
 * - `MachinesCard` — computer-as-sandbox targets live here (Decision 6).
 *   The card self-hides unless cloud-linked, so it mounts unconditionally.
 */

import { useStore } from '@nanostores/react';
import { RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { formatBytes } from '@/renderer/features/Sandboxes/format-bytes';
import {
  $sandboxesError,
  $sandboxProfiles,
  $substrateStatus,
  refreshSandboxSubstrate,
} from '@/renderer/features/Sandboxes/state';
import { MachinesCard } from '@/renderer/features/SettingsModal/MachinesCard';
import { openSettingsTab } from '@/renderer/features/SettingsModal/settings-nav';
import {
  emitter,
  isCloudLinked,
  isElectron,
  isServerLinked,
  isWslLinked,
  localEmitter,
  serverOrigin,
} from '@/renderer/services/ipc';
import type { SandboxImageStatus, SandboxSubstrateStatus, WslBackendStatus } from '@/shared/types';

type StatusLine = { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' };

/**
 * Map the Docker probe to a status line. WSL-linked clients reuse the
 * RemoteBackendCard wording (integration/docker-ce guidance); other
 * backends get generic copy — the fix differs per substrate.
 */
const dockerStatusLine = (status: SandboxSubstrateStatus | null, wslDistro: string | undefined): StatusLine => {
  if (!status) {
    return { text: 'Checking Docker…', tone: 'muted' };
  }
  if (status.docker === 'missing') {
    return isWslLinked
      ? {
          text: `Docker not found in ${wslDistro ?? 'the distro'} — enable Docker Desktop's WSL integration for this distro, or install docker-ce`,
          tone: 'warn',
        }
      : { text: 'Docker is not installed on the backend', tone: 'warn' };
  }
  if (status.docker === 'daemon-down') {
    return isWslLinked
      ? { text: 'Docker is installed but not running', tone: 'warn' }
      : { text: 'Docker is installed but the daemon is not running', tone: 'warn' };
  }
  return { text: `Running${status.dockerVersion ? ` — v${status.dockerVersion}` : ''}`, tone: 'ok' };
};

/** WSL daemon row copy: state + persistent-mode note, mirroring RemoteBackendCard's mapping. */
const wslStatusLine = (status: WslBackendStatus | null): StatusLine => {
  if (!status) {
    return { text: 'Checking daemon status…', tone: 'muted' };
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
  if (status.state === 'running') {
    return {
      text: `Running in ${status.distro ?? 'WSL'} · ${status.persistent ? 'stays up when the app closes' : 'stops with the app'}`,
      tone: 'ok',
    };
  }
  return { text: 'Idle', tone: 'muted' };
};

/** One line describing where the backend runs — the read-only link summary. */
const backendSummary = (): string => {
  if (isCloudLinked) {
    return `Connected to a cloud launcher at ${serverOrigin()}`;
  }
  if (isWslLinked) {
    return `Backend running in WSL at ${serverOrigin()}`;
  }
  if (isServerLinked) {
    return `Connected to a self-hosted server at ${serverOrigin()}`;
  }
  if (!isElectron) {
    return `Running against this deployment (${serverOrigin()})`;
  }
  return 'Backend running locally on this computer';
};

const toneClasses = (tone: StatusLine['tone']): string =>
  tone === 'error'
    ? 'text-destructive'
    : tone === 'warn'
      ? 'text-warning'
      : tone === 'ok'
        ? 'text-success'
        : 'text-muted-foreground';

const WSL_STATUS_POLL_MS = 5000;

const openAccountSettings = (): void => {
  openSettingsTab('Account');
};

export const HealthPane = memo(() => {
  const substrate = useStore($substrateStatus);
  const fetchError = useStore($sandboxesError);

  useEffect(() => {
    void refreshSandboxSubstrate();
  }, []);
  const onRefresh = useCallback(() => {
    void refreshSandboxSubstrate();
  }, []);

  // WSL daemon status is a LOCAL-main concern (`wsl:*` never rides the
  // backend WS) — poll while this pane is visible.
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

  // Docker bootstrap inside the linked distro (missing → install docker-ce,
  // daemon-down → start dockerd). Both are long-running local-main calls.
  const [bootstrapping, setBootstrapping] = useState<'install' | 'start' | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const finishBootstrap = useCallback(async () => {
    refreshWslStatus();
    await refreshSandboxSubstrate();
  }, [refreshWslStatus]);

  const onInstallDocker = useCallback(() => {
    setBootstrapping('install');
    setBootstrapError(null);
    void localEmitter
      .invoke('wsl:install-docker')
      .then(finishBootstrap)
      .catch((err: unknown) => setBootstrapError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBootstrapping(null));
  }, [finishBootstrap]);

  const onStartDocker = useCallback(() => {
    setBootstrapping('start');
    setBootstrapError(null);
    void localEmitter
      .invoke('wsl:start-docker')
      .then(finishBootstrap)
      .catch((err: unknown) => setBootstrapError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBootstrapping(null));
  }, [finishBootstrap]);

  // Images card: the devbox image reference comes from the discovered
  // profile catalog; the card hides when it's unknown or docker isn't ok.
  const profiles = useStore($sandboxProfiles);
  const devboxImage = profiles.find((p) => p.name === 'devbox')?.details?.image ?? null;
  const showImages = substrate?.docker === 'ok' && devboxImage !== null;

  const [imageStatus, setImageStatus] = useState<SandboxImageStatus | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pruneConfirmOpen, setPruneConfirmOpen] = useState(false);
  const [pruneResult, setPruneResult] = useState<string | null>(null);

  const refreshImageStatus = useCallback(() => {
    if (!devboxImage) {
      return;
    }
    setImageError(null);
    void emitter
      .invoke('sandbox:image-status', devboxImage)
      .then(setImageStatus)
      .catch((err: unknown) => setImageError(err instanceof Error ? err.message : String(err)));
  }, [devboxImage]);

  useEffect(() => {
    if (showImages) {
      refreshImageStatus();
    }
  }, [showImages, refreshImageStatus]);

  const onPull = useCallback(() => {
    if (!devboxImage) {
      return;
    }
    setPulling(true);
    setImageError(null);
    void emitter
      .invoke('sandbox:pull-image', devboxImage)
      .then(refreshImageStatus)
      .catch((err: unknown) => setImageError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPulling(false));
  }, [devboxImage, refreshImageStatus]);

  const openPruneConfirm = useCallback(() => setPruneConfirmOpen(true), []);
  const closePruneConfirm = useCallback(() => setPruneConfirmOpen(false), []);

  const onConfirmPrune = useCallback(() => {
    setImageError(null);
    void emitter
      .invoke('sandbox:prune-images')
      .then(({ reclaimedBytes }) => {
        setPruneResult(reclaimedBytes !== null ? `Reclaimed ${formatBytes(reclaimedBytes)}` : 'Prune complete');
        setTimeout(() => setPruneResult(null), 4000);
        refreshImageStatus();
      })
      .catch((err: unknown) => setImageError(err instanceof Error ? err.message : String(err)));
  }, [refreshImageStatus]);

  const docker = dockerStatusLine(substrate, wslStatus?.distro);
  const wsl = wslStatusLine(wslStatus);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
          <CardDescription>Docker powers sandboxed apps and agent sessions on this backend.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-sm">Docker</span>
                <span className={cn('text-xs text-muted-foreground', toneClasses(docker.tone))}>{docker.text}</span>
              </div>
              <div className="flex items-center gap-1 flex-wrap shrink-0 self-start sm:self-center">
                {isWslLinked && substrate?.docker === 'missing' && (
                  <Button size="sm" variant="ghost" onClick={onInstallDocker} disabled={bootstrapping !== null}>
                    {`Install Docker in ${wslStatus?.distro ?? 'the distro'}`}
                  </Button>
                )}
                {isWslLinked && substrate?.docker === 'daemon-down' && (
                  <Button size="sm" variant="ghost" onClick={onStartDocker} disabled={bootstrapping !== null}>
                    Start Docker
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh substrate status"
                  onClick={onRefresh}
                  title="Refresh"
                >
                  <RefreshCw />
                </Button>
              </div>
            </div>
            {bootstrapping !== null && (
              <div className="flex items-center gap-2">
                <Spinner />
                <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                  {bootstrapping === 'install' ? 'Installing Docker — this takes a few minutes…' : 'Starting Docker…'}
                </span>
              </div>
            )}
            {bootstrapError && (
              <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{bootstrapError}</span>
            )}
            {isWslLinked && (
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm">WSL daemon</span>
                  <span className={cn('text-xs text-muted-foreground', toneClasses(wsl.tone))}>{wsl.text}</span>
                </div>
              </div>
            )}
            {fetchError && (
              <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{fetchError}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {showImages && devboxImage && (
        <Card>
          <CardHeader>
            <CardTitle>Images</CardTitle>
            <CardDescription>The base environment used when a Devbox sandbox starts.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm">Devbox image</span>
                  <span
                    className={cn(
                      'text-xs text-muted-foreground',
                      cn('text-muted-foreground', 'font-mono wrap-anywhere')
                    )}
                  >
                    {devboxImage}
                  </span>
                  <span
                    className={cn(
                      'text-xs text-muted-foreground',
                      imageStatus === null
                        ? 'text-muted-foreground'
                        : imageStatus.present
                          ? 'text-success'
                          : 'text-warning'
                    )}
                  >
                    {imageStatus === null
                      ? 'Checking image…'
                      : imageStatus.present
                        ? `Present${imageStatus.sizeBytes !== null ? ` — ${formatBytes(imageStatus.sizeBytes)}` : ''}`
                        : 'Not pulled'}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-wrap shrink-0 self-start sm:self-center">
                  <Button size="sm" variant="ghost" onClick={onPull} disabled={pulling}>
                    {pulling ? 'Pulling…' : 'Pull'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={openPruneConfirm}>
                    Prune unused
                  </Button>
                </div>
              </div>
              {pulling && (
                <div className="flex items-center gap-2">
                  <Spinner />
                  <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                    Pulling — this downloads several GB…
                  </span>
                </div>
              )}
              {pruneResult && (
                <span className={cn('text-xs text-muted-foreground', 'text-success')}>{pruneResult}</span>
              )}
              {imageError && (
                <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{imageError}</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={pruneConfirmOpen} onOpenChange={(open) => !open && closePruneConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prune dangling images?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove all dangling (untagged) Docker images on the backend. Tagged images are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirmPrune}>
              Prune
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>Where sandbox operations run.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className={cn('text-sm text-muted-foreground', 'text-muted-foreground')}>{backendSummary()}</span>
            </div>
            <Button size="sm" variant="ghost" onClick={openAccountSettings}>
              Manage in Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <MachinesCard />
    </div>
  );
});
HealthPane.displayName = 'HealthPane';
