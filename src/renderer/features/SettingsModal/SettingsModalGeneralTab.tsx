import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalPreviewFeatures } from '@/renderer/features/SettingsModal/SettingsModalPreviewFeatures';
import { SettingsModalWeeklyReviewDay } from '@/renderer/features/SettingsModal/SettingsModalWeeklyReviewDay';
import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke1,
  },
});

export const SettingsModalGeneralTab = memo(() => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <SettingsModalWipLimit />
      <div className={styles.divider} />
      <SettingsModalWeeklyReviewDay />
      <div className={styles.divider} />
      <SettingsModalOmniSandboxOptions />
      <div className={styles.divider} />
      <SettingsModalPreviewFeatures />
      <div className={styles.divider} />
      <SettingsModalOptInToLauncherPrereleases />
    </div>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
