import { useStore } from '@nanostores/react';

import { useAutoLaunch, type AutoLaunchPhase } from '@/renderer/hooks/use-auto-launch';
import { persistedStoreApi } from '@/renderer/services/store';

export type ChatAutoLaunchPhase = AutoLaunchPhase;

export const useChatAutoLaunch = () => {
  const store = useStore(persistedStoreApi.$atom);

  const { phase, error, retry, launch } = useAutoLaunch({
    processId: 'chat',
    workspaceDir: store.workspaceDir ?? null,
    logLabel: 'autoLaunch:chat',
  });

  return { phase, error, retry, launch, sandboxEnabled: (store.sandboxBackend ?? 'none') !== 'none' };
};
