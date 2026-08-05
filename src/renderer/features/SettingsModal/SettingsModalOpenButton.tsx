import { Settings } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalOpenButton = memo(({ className }: { className?: string }) => {
  const onClick = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'settings');
  }, []);
  return (
    <Button type="button" variant="ghost" size="icon" aria-label="Settings" onClick={onClick} className={className}>
      <Settings />
    </Button>
  );
});
SettingsModalOpenButton.displayName = 'SettingsModalOpenButton';
