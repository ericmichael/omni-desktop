import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { PiGearFill } from 'react-icons/pi';

import { IconButton } from '@/renderer/ds';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';

export const SettingsModalOpenButton = memo(({ className }: { className?: string }) => {
  const isOpen = useStore($isSettingsOpen);
  const onClick = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);
  return (
    <IconButton
      aria-label="Settings"
      onClick={onClick}
      icon={<PiGearFill />}
      isDisabled={isOpen}
      className={className}
    />
  );
});
SettingsModalOpenButton.displayName = 'SettingsModalOpenButton';
