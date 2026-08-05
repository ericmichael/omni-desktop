import { useStore } from '@nanostores/react';
import { Eye } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalPreviewFeatures = memo(() => {
  const { previewFeatures } = useStore(persistedStoreApi.$atom);
  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);
  const onChange = useCallback(
    (checked: boolean) => {
      persistedStoreApi.setKey('previewFeatures', checked);
      // GA users (no preview features, no enterprise) fall back to the
      // no-isolation `host` profile. Enterprise stays on whatever profile
      // the user selected since the platform path is its own surface.
      if (!checked && !isEnterprise) {
        persistedStoreApi.setKey('defaultProfileName', 'host');
      }
    },
    [isEnterprise]
  );

  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal" className="justify-between gap-4">
        <div className="min-w-0">
          <FieldLabel>
            <span className="flex items-center gap-2">
              <Eye className="text-primary" />
              Enable Preview Features
            </span>
          </FieldLabel>
        </div>
        <Checkbox checked={previewFeatures} onCheckedChange={(checked) => onChange(checked === true)} />
      </Field>
      <span className="text-sm text-muted-foreground sm:text-xs">
        Unlock experimental features that are under active development and may be unstable or change without notice.
      </span>
    </div>
  );
});
SettingsModalPreviewFeatures.displayName = 'SettingsModalPreviewFeatures';
