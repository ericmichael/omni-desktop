import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { PiArrowLeftBold, PiStopFill } from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { Button, IconButton, Spinner } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetTaskId } from '@/shared/types';

import { $fleetTasks, fleetApi } from './state';

export const FleetTaskView = memo(({ taskId }: { taskId: FleetTaskId }) => {
  const tasks = useStore($fleetTasks);
  const store = useStore(persistedStoreApi.$atom);
  const task = tasks[taskId];

  const statusType = task?.status.type ?? 'uninitialized';
  const theme = store.theme ?? 'tokyo-night';
  const sessionId = task?.sessionId;
  const projectId = task?.projectId;
  const runningData = task?.status.type === 'running' ? task.status.data : undefined;
  const baseUiUrl = runningData?.uiUrl;
  const codeServerUrl = runningData?.codeServerUrl;
  const noVncUrl = runningData?.noVncUrl;

  const uiUrl = useMemo(() => {
    if (!baseUiUrl || !sessionId) {
      return undefined;
    }
    const url = new URL(baseUiUrl);
    url.searchParams.set('session', sessionId);
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    return url.toString();
  }, [baseUiUrl, sessionId, theme]);

  const handleBack = useCallback(() => {
    if (projectId) {
      fleetApi.goToProject(projectId);
    } else {
      fleetApi.goToDashboard();
    }
  }, [projectId]);

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
        {task.iteration !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-accent-400 bg-accent-400/10 shrink-0">
            Iteration {task.iteration}
          </span>
        )}
        <div className="flex-1" />
        {(statusType === 'running' || statusType === 'starting') && (
          <IconButton aria-label="Stop" icon={<PiStopFill />} size="sm" onClick={handleStop} />
        )}
      </div>

      <div className="flex-1 min-h-0 p-2">
        {uiUrl ? (
          <CodeSplitLayout uiSrc={uiUrl} codeServerSrc={codeServerUrl} vncSrc={noVncUrl} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
            {(statusType === 'starting' || (statusType === 'running' && !task.sessionId)) && (
              <>
                <Spinner size="lg" />
                <EllipsisLoadingText className="text-sm text-fg-muted">
                  {statusType === 'starting' ? 'Starting sandbox' : 'Initializing session'}
                </EllipsisLoadingText>
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
