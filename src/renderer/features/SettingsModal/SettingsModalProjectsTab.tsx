import { memo } from 'react';

import { Card, CardContent } from '@/renderer/ds/ui/card';
import { SettingsPane, SettingsSection } from '@/renderer/features/SettingsModal/SettingsLayout';
import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';

/** Personal band: how the Projects surface paces autopilot. */
export const SettingsModalProjectsTab = memo(() => {
  return (
    <SettingsPane>
      <SettingsSection title="Autopilot">
        <Card>
          <CardContent>
            <SettingsModalWipLimit />
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalProjectsTab.displayName = 'SettingsModalProjectsTab';
