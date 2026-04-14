import { useEffect } from 'react';

import { type AutoLaunchPhase,useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import type { CodeTabId } from '@/shared/types';

import { $codeTabErrors, $codeTabPhases } from './state';

export type { AutoLaunchPhase };

/**
 * Per-tab auto-launch hook. Thin wrapper over useAutoLaunch with:
 * - supervisor awareness (avoids duplicating supervisor-owned sandboxes)
 * - phase/error sync to nanostore maps for non-React consumers
 */
export const useCodeAutoLaunch = (tabId: CodeTabId, workspaceDir: string | null) => {
  const { phase, error, retry, launch, actor } = useAutoLaunch({
    processId: tabId,
    workspaceDir,
    supervisorAware: true,
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
