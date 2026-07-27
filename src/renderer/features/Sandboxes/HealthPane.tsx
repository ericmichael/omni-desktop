/**
 * Sandboxes → Health: is the substrate able to run sandboxes right now?
 *
 * - Docker probe (`sandbox:substrate-status`) — runs backend-side, so on a
 *   WSL/cloud-linked client it reports the daemon's Docker, not Windows'.
 * - WSL daemon row (Windows, WSL-linked only) — fed by polling `wsl:status`
 *   via `localEmitter`; the daemon manager lives in local Electron main.
 * - Read-only backend-link summary. Link management stays in Settings
 *   (sandboxes-tab-plan.md Decision 5) — this only deep-links there.
 * - `MachinesCard` — computer-as-sandbox targets live here (Decision 6).
 *   The card self-hides unless cloud-linked, so it mounts unconditionally.
 */

import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Button, Caption1, Card, IconButton, SectionLabel } from '@/renderer/ds';
import { $sandboxesError, $substrateStatus, refreshSandboxSubstrate } from '@/renderer/features/Sandboxes/state';
import { MachinesCard } from '@/renderer/features/SettingsModal/MachinesCard';
import { openSettingsTab } from '@/renderer/features/SettingsModal/settings-nav';
import {
  isCloudLinked,
  isElectron,
  isServerLinked,
  isWslLinked,
  localEmitter,
  serverOrigin,
} from '@/renderer/services/ipc';
import type { SandboxSubstrateStatus, WslBackendStatus } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  main: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  summary: { color: tokens.colorNeutralForeground2 },
  error: { color: tokens.colorPaletteRedForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
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
  useEffect(() => {
    if (!isWslLinked) {
      return undefined;
    }
    const refresh = (): void => {
      void localEmitter
        .invoke('wsl:status')
        .then(setWslStatus)
        .catch(() => undefined);
    };
    refresh();
    const interval = setInterval(refresh, WSL_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, []);

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
            <IconButton
              aria-label="Refresh substrate status"
              icon={<ArrowClockwise16Regular />}
              size="sm"
              tooltip="Refresh"
              onClick={onRefresh}
            />
          </div>
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
