import { useStore } from '@nanostores/react';
import { Check, CircleX, CloudDownload, CloudUpload, RefreshCw } from 'lucide-react';
import { memo, useMemo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Progress } from '@/renderer/ds/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { $syncStatuses } from '@/renderer/features/WorkspaceSync/state';
import type { WorkspaceSyncStatus } from '@/shared/types';

function formatEta(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s left`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s left` : `${mins}m left`;
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Aggregate status from all active sync sessions into a single bar message. */
function useAggregateStatus(statuses: Record<string, WorkspaceSyncStatus>) {
  return useMemo(() => {
    const entries = Object.values(statuses);
    if (entries.length === 0) {
      return null;
    }

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
      const phaseLabel = p.phase === 'uploading' ? 'Uploading' : p.phase === 'downloading' ? 'Downloading' : 'Syncing';
      return {
        type: 'progress' as const,
        message: `${phaseLabel} ${p.completedFiles} of ${p.totalFiles} files`,
        totalUploaded,
        totalDownloaded,
        progress: {
          percent: pct * 100,
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
  const agg = useAggregateStatus(statuses);

  if (!agg) {
    return null;
  }

  const icon =
    agg.type === 'error' ? (
      <CircleX />
    ) : agg.type === 'progress' ? (
      agg.progress && agg.progress.percent > 0 ? (
        agg.progress.percent > 0.5 ? (
          <CloudUpload />
        ) : (
          <CloudDownload />
        )
      ) : (
        <RefreshCw />
      )
    ) : agg.type === 'busy' ? (
      <RefreshCw />
    ) : (
      <Check />
    );

  const isSpinning = agg.type === 'busy' || (agg.type === 'progress' && !agg.progress);

  return (
    <div
      className={cn(
        'safe-area-bottom fixed right-0 bottom-0 left-0 z-50 box-content flex h-8 items-center gap-2.5 border-t border-border bg-background px-3 text-xs text-muted-foreground sm:left-64',
        agg.type === 'error' && 'bg-destructive/10 border-destructive/50 text-destructive',
        agg.type === 'watching' && 'max-sm:hidden'
      )}
    >
      <span className={cn('flex items-center shrink-0 [&>_svg]:size-4', isSpinning && 'animate-spin-slow')}>
        {icon}
      </span>
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{agg.message}</span>

      {agg.type === 'progress' && agg.progress && (
        <>
          <Progress className="w-30 shrink-0" value={agg.progress.percent} />
          {agg.progress.rate > 0 && (
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatRate(agg.progress.rate)}</span>
          )}
          {agg.progress.eta !== null && agg.progress.eta > 0 && (
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatEta(agg.progress.eta)}</span>
          )}
        </>
      )}

      {agg.type === 'watching' && (agg.totalUploaded > 0 || agg.totalDownloaded > 0) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-muted-foreground">
              {agg.totalUploaded > 0 && `${agg.totalUploaded}\u2191`}
              {agg.totalUploaded > 0 && agg.totalDownloaded > 0 && ' '}
              {agg.totalDownloaded > 0 && `${agg.totalDownloaded}\u2193`}
            </span>
          </TooltipTrigger>
          <TooltipContent>{`${agg.totalUploaded} uploaded, ${agg.totalDownloaded} downloaded`}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});
SyncBar.displayName = 'SyncBar';
