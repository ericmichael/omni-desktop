import { useEffect } from 'react';

import { type AutoLaunchPhase,useAutoLaunch } from '@/renderer/hooks/use-auto-launch';
import type { CodeTabId } from '@/shared/types';

import { $codeTabErrors, $codeTabPhases } from './state';

export type { AutoLaunchPhase };

/**
 * Per-tab auto-launch hook. Thin wrapper over useAutoLaunch with phase/error
 * sync to nanostore maps for non-React consumers. The Code tab owns the one
 * sandbox per ticket now — there's no separate supervisor sandbox to avoid.
 */
export const useCodeAutoLaunch = (tabId: CodeTabId, workspaceDir: string | null) => {
  const { phase, error, retry, launch, actor } = useAutoLaunch({
    processId: tabId,
    workspaceDir,
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
