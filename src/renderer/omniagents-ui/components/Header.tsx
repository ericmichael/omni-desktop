import { makeStyles, tokens } from '@fluentui/react-components';
import { Navigation20Regular, PanelRight20Regular } from '@fluentui/react-icons';

import { IconButton } from '@/renderer/ds/IconButton';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  leading: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  trailing: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
});

export function Header({
  agentName: _agentName,
  onMenu,
  onArtifactsToggle,
  showArtifactsButton = false,
}: {
  agentName: string
  onMenu?: () => void
  onArtifactsToggle?: () => void
  showArtifactsButton?: boolean
}) {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <div className={styles.leading}>
        {onMenu ? (
          <IconButton
            aria-label="Toggle sidebar"
            tooltip="Toggle sidebar"
            icon={<Navigation20Regular />}
            onClick={onMenu}
          />
        ) : null}
      </div>
      <div className={styles.trailing}>
        {showArtifactsButton && onArtifactsToggle ? (
          <IconButton
            aria-label="Toggle artifacts"
            tooltip="Toggle artifacts"
            icon={<PanelRight20Regular />}
            onClick={onArtifactsToggle}
          />
        ) : null}
      </div>
    </div>
  )
}
