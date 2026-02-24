import { memo, useCallback } from 'react';
import { PiStopFill, PiTrashFill } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { FleetTask } from '@/shared/types';

import { STATUS_COLORS, STATUS_LABELS } from './fleet-constants';
import { fleetApi } from './state';

export const FleetTaskCard = memo(({ task }: { task: FleetTask }) => {
  const statusType = task.status.type;
  const isRunning = statusType === 'running';
  const isStarting = statusType === 'starting';
  const canStop = isRunning || isStarting;
  const isDone = statusType === 'exited' || statusType === 'error';
  const hasHistory = isDone && !!task.lastUrls?.uiUrl && !!task.sessionId;

  const handleStop = useCallback(() => {
    fleetApi.stopTask(task.id);
  }, [task.id]);

  const handleRemove = useCallback(() => {
    fleetApi.removeTask(task.id);
  }, [task.id]);

  const handleView = useCallback(() => {
    fleetApi.goToTask(task.id);
  }, [task.id]);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-surface-border bg-surface-raised">
      <div className={cn('size-2.5 rounded-full shrink-0', STATUS_COLORS[statusType])} />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg truncate">{task.taskDescription}</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">{STATUS_LABELS[statusType] ?? statusType}</span>
          {task.iteration !== undefined && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-accent-400 bg-accent-400/10">
              Iter {task.iteration}
            </span>
          )}
        </div>
      </div>

      {statusType === 'error' && task.status.type === 'error' && (
        <span className="text-xs text-fg-error truncate max-w-[200px]" title={task.status.error.message}>
          {task.status.error.message}
        </span>
      )}

      <div className="flex items-center gap-1 shrink-0">
        {(isRunning || hasHistory) && (
          <Button size="sm" variant="ghost" onClick={handleView}>
            {hasHistory ? 'History' : 'View'}
          </Button>
        )}
        {canStop && <IconButton aria-label="Stop" icon={<PiStopFill />} size="sm" onClick={handleStop} />}
        {isDone && <IconButton aria-label="Remove" icon={<PiTrashFill />} size="sm" onClick={handleRemove} />}
      </div>
    </div>
  );
});
FleetTaskCard.displayName = 'FleetTaskCard';
