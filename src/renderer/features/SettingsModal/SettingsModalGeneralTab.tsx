import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { SettingsModalInstallApp } from '@/renderer/features/SettingsModal/SettingsModalInstallApp';
import { SettingsModalNotifications } from '@/renderer/features/SettingsModal/SettingsModalNotifications';
import { SettingsModalOptInToLauncherPrereleases } from '@/renderer/features/SettingsModal/SettingsModalOptInToLauncherPrereleases';
import { SettingsModalPreviewFeatures } from '@/renderer/features/SettingsModal/SettingsModalPreviewFeatures';
import { isElectron } from '@/renderer/services/ipc';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke1,
  },
});

/**
 * App-level basics only: notifications, preview features, install/updates.
 * Connections live in Account; appearance, projects pacing, and all
 * developer concerns have their own tabs.
 */
export const SettingsModalGeneralTab = memo(() => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <SettingsModalNotifications />
      <div className={styles.divider} />
      <SettingsModalPreviewFeatures />
      {/* Renders nothing (and no divider) unless the browser reports installability. */}
      <SettingsModalInstallApp />
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
