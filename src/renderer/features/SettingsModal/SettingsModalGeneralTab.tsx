import { memo } from 'react';

import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';

export const SettingsModalGeneralTab = memo(() => {
  return (
    <div className="flex flex-col gap-6">
      <SettingsModalOmniSandboxOptions />
      <div className="h-px bg-surface-border" />
      <SettingsModalOptInToLauncherPrereleases />
    </div>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
