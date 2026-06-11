/**
 * Inline status banner shown when an agent process's error carries a
 * structured `kind`. Today we render two surfaces:
 *
 *   - `host-offline` — the laptop hosting a `local:<machineId>` session
 *     dropped its WS to the cloud. The chat keeps its existing messages
 *     but no new ones can land; the banner explains and reassures that
 *     the session will resume when the laptop reconnects.
 *   - `machine-at-capacity` — a fresh start was rejected because the
 *     laptop already has 5 cloud-driven sessions running. Banner offers
 *     stopping one or switching to cloud-ACI.
 *
 * Generic errors (no `kind` / `kind: 'message'`) fall back to the host's
 * own error surface (CodeErrorView, ChatShell `phase: 'error'`); the
 * banner is silent there.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Warning20Filled } from '@fluentui/react-icons';
import { memo } from 'react';

import { Caption1 } from '@/renderer/ds';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    // Float over the session content (anchored to the parent `fullSizeRelative`
    // container) instead of taking a row in normal flow — a transient warning
    // shouldn't reflow / shrink the chat or code surface beneath it.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1),
    margin: tokens.spacingVerticalS,
    boxShadow: tokens.shadow8,
  },
  capacity: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1),
  },
  body: { flex: '1 1 0', minWidth: 0 },
});

export type SessionStatusBannerProps = {
  status: WithTimestamp<AgentProcessStatus> | undefined;
};

export const SessionStatusBanner = memo(({ status }: SessionStatusBannerProps) => {
  const styles = useStyles();
  if (!status) return null;
  // Computer-as-sandbox: the laptop hosting a `local:<machineId>` session is
  // offline, but the agent keeps RUNNING in the cloud (chat + history stay up).
  // Overlay a non-destructive banner over the still-mounted session rather than
  // tearing it down. Resolves automatically when the laptop reconnects (the
  // cloud rebuilds the sandbox; the `hostOffline` flag clears on the next poll).
  if (status.type === 'running' && status.data.hostOffline) {
    return (
      <div className={styles.root} role="status">
        <Warning20Filled />
        <div className={styles.body}>
          <strong>{status.data.hostOfflineMachineLabel ?? 'Your computer'} is offline.</strong>{' '}
          <Caption1 as="span">
            The agent can&apos;t run tools until it reconnects — it resumes automatically.
          </Caption1>
        </div>
      </div>
    );
  }
  if (status.type !== 'error') return null;
  const { kind, machineLabel, message, maxSessions, currentSessions } = status.error;
  if (kind === 'host-offline') {
    return (
      <div className={styles.root} role="status">
        <Warning20Filled />
        <div className={styles.body}>
          <strong>{machineLabel ?? 'Your computer'} is offline.</strong>{' '}
          <Caption1 as="span">
            The session will resume when it reconnects.
          </Caption1>
        </div>
      </div>
    );
  }
  if (kind === 'machine-at-capacity') {
    return (
      <div className={`${styles.root} ${styles.capacity}`} role="status">
        <Warning20Filled />
        <div className={styles.body}>
          <strong>{machineLabel ?? 'Your computer'} is at capacity</strong>{' '}
          <Caption1 as="span">
            ({currentSessions ?? '?'}/{maxSessions ?? '?'} sessions). Stop one or switch this session to cloud.
          </Caption1>
        </div>
      </div>
    );
  }
  // No `kind` set — host-level error UI owns the surface, nothing here.
  void message;
  return null;
});

SessionStatusBanner.displayName = 'SessionStatusBanner';
