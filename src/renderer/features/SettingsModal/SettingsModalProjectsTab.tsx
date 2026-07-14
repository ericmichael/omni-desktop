import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
});

/** Personal band: how the Projects surface paces autopilot. */
export const SettingsModalProjectsTab = memo(() => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <SettingsModalWipLimit />
    </div>
  );
});
SettingsModalProjectsTab.displayName = 'SettingsModalProjectsTab';
