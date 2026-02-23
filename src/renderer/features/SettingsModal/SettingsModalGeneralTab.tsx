import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { PiFlaskFill } from 'react-icons/pi';

import { Checkbox, FormField } from '@/renderer/ds';
import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalGeneralTab = memo(() => {
  const { enableFleet } = useStore(persistedStoreApi.$atom);

  const onChangeFleet = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('enableFleet', checked);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SettingsModalOmniSandboxOptions />
      <div className="h-px bg-surface-border" />
      <SettingsModalOptInToLauncherPrereleases />
      <div className="h-px bg-surface-border" />
      <div className="flex flex-col gap-2">
        <FormField
          label={
            <span className="flex items-center gap-2">
              <PiFlaskFill className="text-yellow-400" />
              Enable Fleet (Experimental)
            </span>
          }
        >
          <Checkbox checked={enableFleet} onCheckedChange={onChangeFleet} />
        </FormField>
        <span className="text-xs text-fg-subtle">
          Enable the Fleet tab for managing multiple sandboxes, tasks, and tickets. This feature is experimental and may
          change or be removed in future releases.
        </span>
      </div>
    </div>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
