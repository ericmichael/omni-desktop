import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { ConnectCloudCard } from '@/renderer/features/SettingsModal/ConnectCloudCard';
import { MachinesCard } from '@/renderer/features/SettingsModal/MachinesCard';
import { SettingsModalOmniSandboxOptions } from '@/renderer/features/SettingsModal/SettingsModalOmniSandboxOptions';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalPreviewFeatures } from '@/renderer/features/SettingsModal/SettingsModalPreviewFeatures';
import { SettingsModalWeeklyReviewDay } from '@/renderer/features/SettingsModal/SettingsModalWeeklyReviewDay';
import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';
import { isCloudLinked, isElectron } from '@/renderer/services/ipc';

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
      {isElectron && (
        <>
          <ConnectCloudCard />
          <div className={styles.divider} />
        </>
      )}
      {isCloudLinked && (
        <>
          <MachinesCard />
          <div className={styles.divider} />
        </>
      )}
      <SettingsModalWipLimit />
      <div className={styles.divider} />
      <SettingsModalWeeklyReviewDay />
      <div className={styles.divider} />
      <SettingsModalOmniSandboxOptions />
      <div className={styles.divider} />
      <SettingsModalPreviewFeatures />
      {/* Launcher auto-update is Electron-only; cloud updates via the container image. */}
      {isElectron && (
        <>
          <div className={styles.divider} />
          <SettingsModalOptInToLauncherPrereleases />
        </>
      )}
    </div>
  );
});
SettingsModalGeneralTab.displayName = 'SettingsModalGeneralTab';
