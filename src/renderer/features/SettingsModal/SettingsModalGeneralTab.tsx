import { memo } from 'react';

import { Card, CardContent } from '@/renderer/ds/ui/card';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { SettingsModalInstallApp } from '@/renderer/features/SettingsModal/SettingsModalInstallApp';
import { SettingsModalNotifications } from '@/renderer/features/SettingsModal/SettingsModalNotifications';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalPreviewFeatures } from '@/renderer/features/SettingsModal/SettingsModalPreviewFeatures';
import { isElectron } from '@/renderer/services/ipc';

/**
 * App-level basics only: notifications, preview features, install/updates.
 * Connections live in Account; appearance, projects pacing, and all
 * developer concerns have their own tabs.
 */
export const SettingsModalGeneralTab = memo(() => {
  return (
    <SettingsPane>
      <SettingsSection title="Notifications">
        <Card>
          <CardContent>
            <SettingsModalNotifications />
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection title="Features">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            <SettingsModalPreviewFeatures />
            {/* Renders nothing unless the browser reports installability. */}
            <SettingsModalInstallApp />
            {/* Launcher auto-update is Electron-only; cloud updates via the container image. */}
            {isElectron && <SettingsModalOptInToLauncherPrereleases />}
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
