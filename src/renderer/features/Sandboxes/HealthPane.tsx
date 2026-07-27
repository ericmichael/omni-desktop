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

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, ConfirmDialog, IconButton, SectionLabel, Spinner } from '@/renderer/ds';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },
  pendingRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
});

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

const toneClasses = (styles: ReturnType<typeof useStyles>, tone: StatusLine['tone']): string =>
  tone === 'error' ? styles.error : tone === 'warn' ? styles.warn : tone === 'ok' ? styles.ok : styles.summary;

const WSL_STATUS_POLL_MS = 5000;

const openAccountSettings = (): void => {
  openSettingsTab('Account');
};

export const HealthPane = memo(() => {
  const styles = useStyles();
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
    <div className={styles.root}>
      <SectionLabel>Substrate</SectionLabel>
      <Card>
        <div className={styles.card}>
          <div className={styles.row}>
            <div className={styles.main}>
              <Body1>Docker</Body1>
              <Caption1 className={toneClasses(styles, docker.tone)}>{docker.text}</Caption1>
            </div>
            <div className={styles.actions}>
              {isWslLinked && substrate?.docker === 'missing' && (
                <Button size="sm" variant="ghost" onClick={onInstallDocker} isDisabled={bootstrapping !== null}>
                  {`Install Docker in ${wslStatus?.distro ?? 'the distro'}`}
                </Button>
              )}
              {isWslLinked && substrate?.docker === 'daemon-down' && (
                <Button size="sm" variant="ghost" onClick={onStartDocker} isDisabled={bootstrapping !== null}>
                  Start Docker
                </Button>
              )}
              <IconButton
                aria-label="Refresh substrate status"
                icon={<ArrowClockwise16Regular />}
                size="sm"
                tooltip="Refresh"
                onClick={onRefresh}
              />
            </div>
          </div>
          {bootstrapping !== null && (
            <div className={styles.pendingRow}>
              <Spinner size="sm" />
              <Caption1 className={styles.summary}>
                {bootstrapping === 'install' ? 'Installing Docker — this takes a few minutes…' : 'Starting Docker…'}
              </Caption1>
            </div>
          )}
          {bootstrapError && <Caption1 className={styles.error}>{bootstrapError}</Caption1>}
          {isWslLinked && (
            <div className={styles.row}>
              <div className={styles.main}>
                <Body1>WSL daemon</Body1>
                <Caption1 className={toneClasses(styles, wsl.tone)}>{wsl.text}</Caption1>
              </div>
            </div>
          )}
          {fetchError && <Caption1 className={styles.error}>{fetchError}</Caption1>}
        </div>
      </Card>

      {showImages && devboxImage && (
        <>
          <SectionLabel>Images</SectionLabel>
          <Card>
            <div className={styles.card}>
              <div className={styles.row}>
                <div className={styles.main}>
                  <Body1>Devbox image</Body1>
                  <Caption1 className={mergeClasses(styles.summary, styles.mono)}>{devboxImage}</Caption1>
                  <Caption1
                    className={imageStatus === null ? styles.summary : imageStatus.present ? styles.ok : styles.warn}
                  >
                    {imageStatus === null
                      ? 'Checking image…'
                      : imageStatus.present
                        ? `Present${imageStatus.sizeBytes !== null ? ` — ${formatBytes(imageStatus.sizeBytes)}` : ''}`
                        : 'Not pulled'}
                  </Caption1>
                </div>
                <div className={styles.actions}>
                  <Button size="sm" variant="ghost" onClick={onPull} isDisabled={pulling}>
                    {pulling ? 'Pulling…' : 'Pull'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={openPruneConfirm}>
                    Prune dangling images
                  </Button>
                </div>
              </div>
              {pulling && (
                <div className={styles.pendingRow}>
                  <Spinner size="sm" />
                  <Caption1 className={styles.summary}>Pulling — this downloads several GB…</Caption1>
                </div>
              )}
              {pruneResult && <Caption1 className={styles.ok}>{pruneResult}</Caption1>}
              {imageError && <Caption1 className={styles.error}>{imageError}</Caption1>}
            </div>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={pruneConfirmOpen}
        onClose={closePruneConfirm}
        onConfirm={onConfirmPrune}
        title="Prune dangling images?"
        description="Remove all dangling (untagged) Docker images on the backend. Tagged images are untouched."
        confirmLabel="Prune"
        destructive
      />

      <SectionLabel>Backend</SectionLabel>
      <Card>
        <div className={styles.row}>
          <div className={styles.main}>
            <Caption1 className={styles.summary}>{backendSummary()}</Caption1>
          </div>
          <Button size="sm" variant="ghost" onClick={openAccountSettings}>
            Manage in Settings
          </Button>
        </div>
      </Card>

      <MachinesCard />
    </div>
  );
});
HealthPane.displayName = 'HealthPane';
