import { memo } from 'react';

import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalPreviewFeatures } from '@/renderer/features/SettingsModal/SettingsModalPreviewFeatures';
import { SettingsModalWeeklyReviewDay } from '@/renderer/features/SettingsModal/SettingsModalWeeklyReviewDay';
import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';

export const SettingsModalGeneralTab = memo(() => {
  return (
    <div className="flex flex-col gap-6">
      <SettingsModalWipLimit />
      <div className="h-px bg-surface-border" />
      <SettingsModalWeeklyReviewDay />
      <div className="h-px bg-surface-border" />
      <SettingsModalOmniSandboxOptions />
      <div className="h-px bg-surface-border" />
      <SettingsModalPreviewFeatures />
      <div className="h-px bg-surface-border" />
      <SettingsModalOptInToLauncherPrereleases />
    </div>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
