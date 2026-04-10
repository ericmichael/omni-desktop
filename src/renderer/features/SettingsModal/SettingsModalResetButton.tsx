import { memo, useCallback, useState } from 'react';

import { Button, ConfirmDialog } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalResetButton = memo(() => {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const openConfirm = useCallback(() => setConfirmOpen(true), []);
  const closeConfirm = useCallback(() => setConfirmOpen(false), []);

  const handleReset = useCallback(() => {
    persistedStoreApi.reset();
    persistedStoreApi.setKey('layoutMode', 'home');
  }, []);

  return (
    <>
      <Button size="sm" variant="destructive" onClick={openConfirm}>
        Reset Launcher Settings
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onClose={closeConfirm}
        onConfirm={handleReset}
        title="Reset all settings?"
        description="This will restore all launcher settings to their defaults. Your projects and data will not be deleted, but configuration such as theme, models, and sandbox options will be lost."
        confirmLabel="Reset"
        destructive
      />
    </>
  );
});
SettingsModalResetButton.displayName = 'SettingsModalResetButton';
