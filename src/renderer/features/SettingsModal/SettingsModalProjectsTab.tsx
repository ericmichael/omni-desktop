import { makeStyles, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { SettingsModalWeeklyReviewDay } from '@/renderer/features/SettingsModal/SettingsModalWeeklyReviewDay';
import { SettingsModalWipLimit } from '@/renderer/features/SettingsModal/SettingsModalWipLimit';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke1,
  },
});

/** Personal band: how the Projects surface paces your work. */
export const SettingsModalProjectsTab = memo(() => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <SettingsModalWipLimit />
      <div className={styles.divider} />
      <SettingsModalWeeklyReviewDay />
    </div>
  );
});
SettingsModalProjectsTab.displayName = 'SettingsModalProjectsTab';
