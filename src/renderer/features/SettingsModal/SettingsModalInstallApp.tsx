import { useStore } from '@nanostores/react';
import { Download } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Separator } from '@/renderer/ds/ui/separator';
import { $installPrompt, promptInstall } from '@/renderer/services/pwa-install';

/**
 * "Install app" action, shown only when the browser reports the PWA as
 * installable (`beforeinstallprompt`). Renders nothing — including its own
 * divider — everywhere else, so the General tab doesn't carry an empty slot.
 */
export const SettingsModalInstallApp = memo(() => {
  const installPrompt = useStore($installPrompt);

  const onInstall = useCallback(() => {
    void promptInstall();
  }, []);

  if (!installPrompt) {
    return null;
  }

  return (
    <>
      <Separator />
      <div className="flex flex-col gap-2 items-start">
        <Button variant="ghost" size="sm" onClick={onInstall}>
          <Download />
          Install app
        </Button>
        <span className="text-sm text-muted-foreground sm:text-xs">
          Install Omni on this device: its own window, an app icon, and badges when agents need you.
        </span>
      </div>
    </>
  );
});
SettingsModalInstallApp.displayName = 'SettingsModalInstallApp';
