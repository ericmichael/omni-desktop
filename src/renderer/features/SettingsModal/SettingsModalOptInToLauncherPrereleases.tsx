import { useStore } from '@nanostores/react';
import { Beaker } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalOptInToLauncherPrereleases = memo(() => {
  const { optInToLauncherPrereleases } = useStore(persistedStoreApi.$atom);
  const onChange = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('optInToLauncherPrereleases', checked);
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal" className="justify-between gap-4">
        <div className="min-w-0">
          <FieldLabel>
            <span className="flex items-center gap-2">
              <Beaker className="text-warning" />
              Opt-in to Launcher Prereleases
            </span>
          </FieldLabel>
        </div>
        <Checkbox checked={optInToLauncherPrereleases} onCheckedChange={(checked) => onChange(checked === true)} />
      </Field>
      <span className="text-sm text-muted-foreground sm:text-xs">
        Check for prerelease versions of the launcher on startup. If disabled, the launcher will only check for stable
        releases.
      </span>
    </div>
  );
});
SettingsModalOptInToLauncherPrereleases.displayName = 'SettingsModalOptInToLauncherPrereleases';
