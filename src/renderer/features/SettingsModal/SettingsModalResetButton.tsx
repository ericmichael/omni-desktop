import { memo, useCallback, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalResetButton = memo(() => {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const openConfirm = useCallback(() => setConfirmOpen(true), []);
  const closeConfirm = useCallback(() => setConfirmOpen(false), []);

  const handleReset = useCallback(() => {
    persistedStoreApi.reset();
    persistedStoreApi.setKey('layoutMode', 'chat');
  }, []);

  return (
    <>
      <Button size="sm" variant="destructive" onClick={openConfirm}>
        Reset Launcher Settings
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all settings?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore all launcher settings to their defaults. Your projects and data will not be deleted, but
              configuration such as theme, models, and sandbox options will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleReset}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});
SettingsModalResetButton.displayName = 'SettingsModalResetButton';
