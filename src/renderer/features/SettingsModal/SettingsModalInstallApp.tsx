import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownload20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds';
import { $installPrompt, promptInstall } from '@/renderer/services/pwa-install';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, alignItems: 'flex-start' },
  hint: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  divider: {
    height: '1px',
    alignSelf: 'stretch',
    backgroundColor: tokens.colorNeutralStroke1,
  },
});

/**
 * "Install app" action, shown only when the browser reports the PWA as
 * installable (`beforeinstallprompt`). Renders nothing — including its own
 * divider — everywhere else, so the General tab doesn't carry an empty slot.
 */
export const SettingsModalInstallApp = memo(() => {
  const styles = useStyles();
  const installPrompt = useStore($installPrompt);

  const onInstall = useCallback(() => {
    void promptInstall();
  }, []);

  if (!installPrompt) {
    return null;
  }

  return (
    <>
      <div className={styles.divider} />
      <div className={styles.root}>
        <Button variant="ghost" size="sm" leftIcon={<ArrowDownload20Regular />} onClick={onInstall}>
          Install app
        </Button>
        <span className={styles.hint}>
          Install Omni on this device: its own window, an app icon, and badges when agents need you.
        </span>
      </div>
    </>
  );
});
SettingsModalInstallApp.displayName = 'SettingsModalInstallApp';
