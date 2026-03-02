import { useStore } from '@nanostores/react';
import type { ComponentType } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiArrowLeftBold, PiCodeBold, PiMonitorBold, PiRobotBold, PiStopFill } from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { Webview } from '@/renderer/common/Webview';
import { Button, IconButton, Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetTaskId } from '@/shared/types';

import { FleetSessionHistory } from './FleetSessionHistory';
import { $fleetTasks, fleetApi } from './state';

type MainView = 'omni' | 'code' | 'vnc';

type ViewDef = {
  key: MainView;
  label: string;
  icon: ComponentType<{ size: number }>;
  src: string | undefined;
};

export const FleetTaskView = memo(({ taskId }: { taskId: FleetTaskId }) => {
  const tasks = useStore($fleetTasks);
  const store = useStore(persistedStoreApi.$atom);
  const task = tasks[taskId];

  const statusType = task?.status.type ?? 'uninitialized';
  const theme = store.theme ?? 'tokyo-night';
  const sessionId = task?.sessionId;
  const projectId = task?.projectId;
  const runningData = task?.status.type === 'running' ? task.status.data : undefined;
  const baseUiUrl = runningData?.uiUrl ?? task?.lastUrls?.uiUrl;
  const codeServerUrl = runningData?.codeServerUrl ?? task?.lastUrls?.codeServerUrl;
  const noVncUrl = runningData?.noVncUrl ?? task?.lastUrls?.noVncUrl;

  const isContainerLive = statusType === 'running' || statusType === 'starting';
  const isExitedOrError = statusType === 'exited' || statusType === 'error' || statusType === 'uninitialized';

  const uiUrl = useMemo(() => {
    if (!baseUiUrl) {
      return undefined;
    }
    const url = new URL(baseUiUrl, window.location.origin);
    if (sessionId) {
      url.searchParams.set('session', sessionId);
    }
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

  const [mainView, setMainView] = useState<MainView>('omni');
  const [splitSrc, setSplitSrc] = useState<string | null>(null);

  const views: ViewDef[] = useMemo(
    () => [
      { key: 'omni', label: 'Agent', icon: PiRobotBold, src: uiUrl },
      { key: 'code', label: 'VS Code', icon: PiCodeBold, src: codeServerUrl },
      { key: 'vnc', label: "Omni's PC", icon: PiMonitorBold, src: noVncUrl },
    ],
    [uiUrl, codeServerUrl, noVncUrl]
  );

  const switchTo = useCallback(
    (view: MainView) => {
      const src = views.find((v) => v.key === view)?.src;
      setSplitSrc((prev) => (prev && prev === src ? null : prev));
      setMainView(view);
    },
    [views]
  );

  const handleSetOmni = useCallback(() => switchTo('omni'), [switchTo]);
  const handleSetCode = useCallback(() => switchTo('code'), [switchTo]);
  const handleSetVnc = useCallback(() => switchTo('vnc'), [switchTo]);

  const setters: Record<MainView, () => void> = useMemo(
    () => ({ omni: handleSetOmni, code: handleSetCode, vnc: handleSetVnc }),
    [handleSetOmni, handleSetCode, handleSetVnc]
  );

  const currentView = views.find((v) => v.key === mainView);
  const mainSrc = currentView?.src;
  const pills = views.filter((v) => v.key !== mainView && v.src);

  const handleToggleSplit = useCallback(
    (src: string | undefined) => {
      if (!src) {
        return;
      }
      setSplitSrc((prev) => (prev === src ? null : src));
    },
    []
  );

  // Dummy overlay state — pills use onClick to swap main view, overlay is unused
  const [overlayKey, setOverlayKey] = useState<string | null>(null);
  const handleOpenOverlay = useCallback((key: string) => () => setOverlayKey(key), []);
  const handleCloseOverlay = useCallback(() => setOverlayKey(null), []);

  if (!task) {
    return null;
  }

  // Priority: live webview (running container) > session history from DB > fallback message
  const showWebview = uiUrl && isContainerLive;
  const showSessionHistory = !showWebview && isExitedOrError && sessionId;

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

      <div className="flex-1 min-h-0">
        {showWebview ? (
          <div className="h-full relative">
            {splitSrc && mainSrc ? (
              <CodeSplitLayout codeServerSrc={mainSrc} uiSrc={splitSrc} />
            ) : (
              <Webview src={mainSrc} showUnavailable={false} />
            )}
            {pills.map((pill, i) => (
              <FloatingWidget
                key={pill.key}
                src={pill.src!}
                label={pill.label}
                icon={pill.icon}
                overlayOpen={overlayKey === pill.key}
                onOpenOverlay={handleOpenOverlay(pill.key)}
                onCloseOverlay={handleCloseOverlay}
                onClick={setters[pill.key]}
                className={i === 0 ? 'top-[82%]' : 'top-[88%]'}
                defaultPreviewSize={pill.key === 'code' ? { width: 560, height: 380 } : undefined}
                resizable
                onToggleSplit={handleToggleSplit.bind(null, pill.src)}
                splitOpen={splitSrc === pill.src}
              />
            ))}
          </div>
        ) : showSessionHistory ? (
          <FleetSessionHistory sessionId={sessionId} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
            {statusType === 'starting' && (
              <>
                <Spinner size="lg" />
                <EllipsisLoadingText className="text-sm text-fg-muted">
                  Starting sandbox
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
