import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { memo } from 'react';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    flexShrink: 0,
  },
  settingsBtn: { position: 'absolute', left: '12px' },
  center: { flex: '1 1 0', display: 'flex', justifyContent: 'center' },
});

export const Banner = memo(() => {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <SettingsModalOpenButton className={styles.settingsBtn} />
      <div className={styles.center}>
        <AsciiLogo className="text-[5px]" />
      </div>
    </div>
  );
});
Banner.displayName = 'Banner';
