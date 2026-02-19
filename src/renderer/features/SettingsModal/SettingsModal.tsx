import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { AnimatedDialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';

export const SettingsModal = memo(() => {
  const isOpen = useStore($isSettingsOpen);
  const onClose = useCallback(() => {
    $isSettingsOpen.set(false);
  }, []);

  return (
    <AnimatedDialog open={isOpen} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Settings</DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          <SettingsModalOmniSandboxOptions />
          <div className="h-px bg-surface-border" />
          <SettingsModalOptInToLauncherPrereleases />
        </DialogBody>
        <DialogFooter className="pt-4">
          <SettingsModalResetButton />
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
SettingsModal.displayName = 'SettingsModal';
