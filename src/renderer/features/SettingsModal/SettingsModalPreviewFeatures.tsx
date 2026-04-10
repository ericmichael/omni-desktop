import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { Eye20Filled } from '@fluentui/react-icons';

import { makeStyles, tokens } from '@fluentui/react-components';
import { Checkbox, FormField } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  labelRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  labelIcon: { color: tokens.colorBrandForeground1 },
  hint: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalPreviewFeatures = memo(() => {
  const styles = useStyles();
  const { previewFeatures } = useStore(persistedStoreApi.$atom);
  const onChange = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('previewFeatures', checked);
    if (!checked) {
      // Reset to chat mode when disabling preview features to avoid being stuck on a hidden tab
      persistedStoreApi.setKey('layoutMode', 'chat');
    }
  }, []);

  return (
    <div className={styles.root}>
      <FormField
        label={
          <span className={styles.labelRow}>
            <Eye20Filled className={styles.labelIcon} />
            Enable Preview Features
          </span>
        }
      >
        <Checkbox checked={previewFeatures} onCheckedChange={onChange} />
      </FormField>
      <span className={styles.hint}>
        Unlock experimental features such as Projects, Work, and Code tabs. These features are under active development and
        may be unstable or change without notice.
      </span>
    </div>
  );
});
SettingsModalPreviewFeatures.displayName = 'SettingsModalPreviewFeatures';
