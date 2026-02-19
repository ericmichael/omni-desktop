import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { PiFlaskFill } from 'react-icons/pi';

import { Checkbox, FormField } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalOptInToLauncherPrereleases = memo(() => {
  const { optInToLauncherPrereleases } = useStore(persistedStoreApi.$atom);
  const onChange = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('optInToLauncherPrereleases', checked);
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <FormField
        label={
          <span className="flex items-center gap-2">
            <PiFlaskFill className="text-yellow-400" />
            Opt-in to Launcher Prereleases
          </span>
        }
      >
        <Checkbox checked={optInToLauncherPrereleases} onCheckedChange={onChange} />
      </FormField>
      <span className="text-xs text-fg-subtle">
        Check for prerelease versions of the launcher on startup. If disabled, the launcher will only check for stable
        releases.
      </span>
    </div>
  );
});
SettingsModalOptInToLauncherPrereleases.displayName = 'SettingsModalOptInToLauncherPrereleases';
