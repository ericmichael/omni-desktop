import { useStore } from '@nanostores/react';
import { useEffect, useMemo } from 'react';

import { type AutoLaunchPhase, useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import { useSessionWorkspaceDir } from '@/renderer/hooks/use-session-workspace-dir';
import { persistedStoreApi } from '@/renderer/services/store';

import {
  $globalProcessStatus,
  getGlobalContainerId,
  getGlobalSessionId,
  GLOBAL_AGENT_PROFILE,
  GLOBAL_PROCESS_ID,
  setGlobalContainerId,
} from './state';

export type GlobalAutoLaunchPhase = AutoLaunchPhase;

/**
 * Drives the headless orchestrator's sandbox lifecycle. Mirrors
 * `useChatAutoLaunch` but for the `"global"` process on the Devbox profile,
 * with a renderer-local (localStorage) session/container id.
 */
export const useGlobalAutoLaunch = () => {
  const store = useStore(persistedStoreApi.$atom);
  const status = useStore($globalProcessStatus);

  const sessionId = useMemo(() => getGlobalSessionId(), []);
  const containerId = useMemo(() => getGlobalContainerId(), []);

  // The orchestrator isn't a project — give it an isolated per-session scratch
  // dir instead of mounting the whole workspace tree.
  const workspaceDir = useSessionWorkspaceDir(store.workspaceDir, sessionId);

  const { phase, error, retry, launch } = useAutoLaunch({
    processId: GLOBAL_PROCESS_ID,
    workspaceDir,
    sessionId,
    profileNameOverride: GLOBAL_AGENT_PROFILE,
    ...(containerId ? { containerId } : {}),
    logLabel: 'autoLaunch:global',
  });

  // Capture the container id whenever omni serve reports running, for warm
  // reattach on the next launch.
  useEffect(() => {
    if (status.type !== 'running') {
      return;
    }
    setGlobalContainerId(status.data.containerId ?? null);
  }, [status]);

  return { phase, error, retry, launch, sessionId, status };
};
