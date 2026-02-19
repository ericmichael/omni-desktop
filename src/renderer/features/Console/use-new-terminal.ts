import { useStore } from '@nanostores/react';
import { useCallback } from 'react';

import { initializeTerminal } from '@/renderer/features/Console/state';
import { persistedStoreApi } from '@/renderer/services/store';

export const useNewTerminal = () => {
  const store = useStore(persistedStoreApi.$atom);
  const newTerminal = useCallback(() => {
    const cwd = store.workspaceDir ?? undefined;
    initializeTerminal(cwd);
  }, [store.workspaceDir]);

  return newTerminal;
};
