import { memo, useCallback } from 'react';
import { Settings20Filled } from '@fluentui/react-icons';

import { IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalOpenButton = memo(({ className }: { className?: string }) => {
  const onClick = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'settings');
  }, []);
  return (
    <IconButton
      aria-label="Settings"
      onClick={onClick}
      icon={<Settings20Filled />}
      className={className}
    />
  );
});
SettingsModalOpenButton.displayName = 'SettingsModalOpenButton';
