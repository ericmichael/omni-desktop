import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { PiArrowLeftBold, PiStopFill } from 'react-icons/pi';

import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { Webview } from '@/renderer/common/Webview';
import { Button, IconButton, Spinner } from '@/renderer/ds';
import type { FleetTaskId } from '@/shared/types';

import { $fleetTasks, fleetApi } from './state';

export const FleetTaskView = memo(({ taskId }: { taskId: FleetTaskId }) => {
  const tasks = useStore($fleetTasks);
  const task = tasks[taskId];

  const statusType = task?.status.type ?? 'uninitialized';

  const uiUrl = useMemo(() => {
    if (task?.status.type !== 'running') {
      return undefined;
    }
    return task.status.data.uiUrl;
  }, [task]);

  const handleBack = useCallback(() => {
    if (task) {
      fleetApi.goToProject(task.projectId);
    } else {
      fleetApi.goToDashboard();
    }
  }, [task]);

  const handleStop = useCallback(() => {
    fleetApi.stopTask(taskId);
  }, [taskId]);

  if (!task) {
    return null;
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border shrink-0">
        <Button size="sm" variant="ghost" onClick={handleBack}>
          <PiArrowLeftBold size={14} />
          <span className="ml-1">Back</span>
        </Button>
        <span className="text-sm text-fg truncate">{task.taskDescription}</span>
        <div className="flex-1" />
        {(statusType === 'running' || statusType === 'starting') && (
          <IconButton aria-label="Stop" icon={<PiStopFill />} size="sm" onClick={handleStop} />
        )}
      </div>

      <div className="flex-1 min-h-0 p-2">
        {uiUrl ? (
          <Webview src={uiUrl} showUnavailable={false} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
            {statusType === 'starting' && (
              <>
                <Spinner size="lg" />
                <EllipsisLoadingText className="text-sm text-fg-muted">Starting sandbox</EllipsisLoadingText>
              </>
            )}
            {statusType === 'error' && task.status.type === 'error' && (
              <div className="bg-red-400/5 border border-red-400/20 rounded-lg px-4 py-3 max-w-md">
                <span className="text-sm text-fg-error">{task.status.error.message}</span>
              </div>
            )}
            {(statusType === 'uninitialized' || statusType === 'exited') && (
              <span className="text-sm text-fg-muted">Task sandbox has stopped</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
FleetTaskView.displayName = 'FleetTaskView';
