import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalResetButton = memo(() => {
  const onClick = useCallback(() => {
    persistedStoreApi.reset();
    $isSettingsOpen.set(false);
  }, []);
  return (
    <Button size="sm" variant="destructive" onClick={onClick}>
      Reset Launcher Settings
    </Button>
  );
});
SettingsModalResetButton.displayName = 'SettingsModalResetButton';
