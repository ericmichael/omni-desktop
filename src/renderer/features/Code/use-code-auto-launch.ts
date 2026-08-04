import { useEffect } from 'react';

import { type AutoLaunchPhase, useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import type { CodeTabId } from '@/shared/types';

import { $codeTabErrors, $codeTabPhases } from './state';

export type { AutoLaunchPhase };

/**
 * Per-tab auto-launch hook. Thin wrapper over useAutoLaunch with phase/error
 * sync to nanostore maps for non-React consumers. Each Code tab selects one
 * consumer environment inside a compatible shared AgentHost.
 *
 * *projectId* is forwarded so ProcessManager picks up per-project profile
 * overrides; *profileNameOverride* is the pre-launch picker selection
 * (wins over project + default).
 */
export const useCodeAutoLaunch = (
  tabId: CodeTabId,
  workspaceDir: string | null,
  opts?: {
    projectId?: string;
    sourceOverrideDir?: string;
    profileNameOverride?: string;
    sessionId?: string;
    snapshotRef?: string;
  }
) => {
  const { phase, retry, launch, actor } = useAutoLaunch({
    processId: tabId,
    workspaceDir,
    ...(opts?.projectId ? { projectId: opts.projectId } : {}),
    ...(opts?.sourceOverrideDir ? { sourceOverrideDir: opts.sourceOverrideDir } : {}),
    ...(opts?.profileNameOverride ? { profileNameOverride: opts.profileNameOverride } : {}),
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts?.snapshotRef ? { snapshotRef: opts.snapshotRef } : {}),
    logLabel: 'autoLaunch:code',
  });

  // Sync machine state to nanostore atoms (for non-React consumers)
  useEffect(() => {
    const sub = actor.subscribe((snapshot) => {
      $codeTabPhases.setKey(tabId, snapshot.value as AutoLaunchPhase);
      $codeTabErrors.setKey(tabId, snapshot.context.error);
    });
    return () => sub.unsubscribe();
  }, [actor, tabId]);

  return { phase, retry, launch };
};
