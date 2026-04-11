import { makeStyles, mergeClasses, tokens, ProgressBar, Tooltip } from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  Checkmark20Regular,
  CloudArrowUp20Regular,
  CloudArrowDown20Regular,
  ErrorCircle20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useMemo } from 'react';

import { $syncStatuses } from '@/renderer/features/WorkspaceSync/state';
import type { WorkspaceSyncStatus } from '@/shared/types';

const useStyles = makeStyles({
  bar: {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    height: '32px',
    paddingLeft: '12px',
    paddingRight: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke2,
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      left: '78px', // sidebar width
    },
  },
  barError: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    borderTopColor: tokens.colorPaletteRedBorder1,
    color: tokens.colorPaletteRedForeground1,
  },
  icon: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    '> svg': {
      width: '16px',
      height: '16px',
    },
  },
  spinning: {
    animationName: {
      from: { transform: 'rotate(0deg)' },
      to: { transform: 'rotate(360deg)' },
    },
    animationDuration: '1.5s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
  },
  label: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  progress: {
    width: '120px',
    flexShrink: 0,
  },
  eta: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  stats: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
});

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s left`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s left` : `${mins}m left`;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Aggregate status from all active sync sessions into a single bar message. */
function useAggregateStatus(statuses: Record<string, WorkspaceSyncStatus>) {
  return useMemo(() => {
    const entries = Object.values(statuses);
    if (entries.length === 0) return null;

    // Find the most "active" status
    const error = entries.find((s) => s.state === 'error');
    const syncing = entries.find((s) => s.state === 'syncing');
    const starting = entries.find((s) => s.state === 'starting');
    const withProgress = entries.find((s) => s.progress);
    const active = syncing ?? starting ?? withProgress;

    const totalUploaded = entries.reduce((sum, s) => sum + s.filesUploaded, 0);
    const totalDownloaded = entries.reduce((sum, s) => sum + s.filesDownloaded, 0);

    if (error) {
      return {
        type: 'error' as const,
        message: error.error ?? 'Sync error',
        totalUploaded,
        totalDownloaded,
        progress: null,
      };
    }

    if (active?.progress) {
      const p = active.progress;
      const pct = p.totalFiles > 0 ? p.completedFiles / p.totalFiles : 0;
      const phaseLabel =
        p.phase === 'uploading' ? 'Uploading' : p.phase === 'downloading' ? 'Downloading' : 'Syncing';
      return {
        type: 'progress' as const,
        message: `${phaseLabel} ${p.completedFiles} of ${p.totalFiles} files`,
        totalUploaded,
        totalDownloaded,
        progress: {
          percent: pct,
          eta: p.etaSeconds,
          rate: p.bytesPerSecond,
        },
      };
    }

    if (active) {
      return {
        type: 'busy' as const,
        message: active.state === 'starting' ? 'Preparing workspace sync...' : 'Syncing workspace...',
        totalUploaded,
        totalDownloaded,
        progress: null,
      };
    }

    // All are in 'watching' state
    return {
      type: 'watching' as const,
      message: 'Workspace synced',
      totalUploaded,
      totalDownloaded,
      progress: null,
    };
  }, [statuses]);
}

export const SyncBar = memo(() => {
  const statuses = useStore($syncStatuses);
  const styles = useStyles();
  const agg = useAggregateStatus(statuses);

  if (!agg) return null;

  const icon =
    agg.type === 'error' ? (
      <ErrorCircle20Regular />
    ) : agg.type === 'progress' ? (
      agg.progress && agg.progress.percent > 0 ? (
        agg.progress.percent > 0.5 ? (
          <CloudArrowUp20Regular />
        ) : (
          <CloudArrowDown20Regular />
        )
      ) : (
        <ArrowSync20Regular />
      )
    ) : agg.type === 'busy' ? (
      <ArrowSync20Regular />
    ) : (
      <Checkmark20Regular />
    );

  const isSpinning = agg.type === 'busy' || (agg.type === 'progress' && !agg.progress);

  return (
    <div className={mergeClasses(styles.bar, agg.type === 'error' && styles.barError)}>
      <span className={mergeClasses(styles.icon, isSpinning && styles.spinning)}>{icon}</span>
      <span className={styles.label}>{agg.message}</span>

      {agg.type === 'progress' && agg.progress && (
        <>
          <ProgressBar
            className={styles.progress}
            value={agg.progress.percent}
            thickness="medium"
            shape="rounded"
          />
          {agg.progress.rate > 0 && <span className={styles.eta}>{formatRate(agg.progress.rate)}</span>}
          {agg.progress.eta != null && agg.progress.eta > 0 && (
            <span className={styles.eta}>{formatEta(agg.progress.eta)}</span>
          )}
        </>
      )}

      {agg.type === 'watching' && (agg.totalUploaded > 0 || agg.totalDownloaded > 0) && (
        <Tooltip
          content={`${agg.totalUploaded} uploaded, ${agg.totalDownloaded} downloaded`}
          relationship="description"
        >
          <span className={styles.stats}>
            {agg.totalUploaded > 0 && `${agg.totalUploaded}\u2191`}
            {agg.totalUploaded > 0 && agg.totalDownloaded > 0 && ' '}
            {agg.totalDownloaded > 0 && `${agg.totalDownloaded}\u2193`}
          </span>
        </Tooltip>
      )}
    </div>
  );
});
SyncBar.displayName = 'SyncBar';
