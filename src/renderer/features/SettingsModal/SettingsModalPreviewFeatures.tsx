import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { PiEyeFill } from 'react-icons/pi';

import { Checkbox, FormField } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalPreviewFeatures = memo(() => {
  const { previewFeatures } = useStore(persistedStoreApi.$atom);
  const onChange = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('previewFeatures', checked);
    if (!checked) {
      // Reset to chat mode when disabling preview features to avoid being stuck on a hidden tab
      persistedStoreApi.setKey('layoutMode', 'chat');
    }
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <FormField
        label={
          <span className="flex items-center gap-2">
            <PiEyeFill className="text-accent-400" />
            Enable Preview Features
          </span>
        }
      >
        <Checkbox checked={previewFeatures} onCheckedChange={onChange} />
      </FormField>
      <span className="text-xs text-fg-subtle">
        Unlock experimental features such as Fleet, Work, and Code tabs. These features are under active development and
        may be unstable or change without notice.
      </span>
    </div>
  );
});
SettingsModalPreviewFeatures.displayName = 'SettingsModalPreviewFeatures';
