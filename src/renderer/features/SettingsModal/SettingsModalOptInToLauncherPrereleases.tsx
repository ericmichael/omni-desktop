import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { Beaker20Filled } from '@fluentui/react-icons';

import { makeStyles, tokens } from '@fluentui/react-components';
import { Checkbox, FormField } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  labelRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  labelIcon: { color: tokens.colorPaletteYellowForeground1 },
  hint: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalOptInToLauncherPrereleases = memo(() => {
  const styles = useStyles();
  const { optInToLauncherPrereleases } = useStore(persistedStoreApi.$atom);
  const onChange = useCallback((checked: boolean) => {
    persistedStoreApi.setKey('optInToLauncherPrereleases', checked);
  }, []);

  return (
    <div className={styles.root}>
      <FormField
        label={
          <span className={styles.labelRow}>
            <Beaker20Filled className={styles.labelIcon} />
            Opt-in to Launcher Prereleases
          </span>
        }
      >
        <Checkbox checked={optInToLauncherPrereleases} onCheckedChange={onChange} />
      </FormField>
      <span className={styles.hint}>
        Check for prerelease versions of the launcher on startup. If disabled, the launcher will only check for stable
        releases.
      </span>
    </div>
  );
});
SettingsModalOptInToLauncherPrereleases.displayName = 'SettingsModalOptInToLauncherPrereleases';
