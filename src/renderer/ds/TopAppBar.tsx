import {
  Toolbar,
  ToolbarButton,
  makeStyles,
  mergeClasses,
  tokens,
  Subtitle2,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { ArrowLeft20Regular } from '@fluentui/react-icons';

type TopAppBarProps = {
  title: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: tokens.colorNeutralStroke1,
    flexShrink: 0,
  },
  title: {
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
});

export const TopAppBar = ({ title, onBack, actions, className }: TopAppBarProps) => {
  const styles = useStyles();
  return (
    <Toolbar className={mergeClasses(styles.root, className)}>
      {onBack && (
        <ToolbarButton
          aria-label="Back"
          icon={<ArrowLeft20Regular />}
          appearance="subtle"
          onClick={onBack}
        />
      )}
      <Subtitle2 className={styles.title}>{title}</Subtitle2>
      {actions && <div className={styles.actions}>{actions}</div>}
    </Toolbar>
  );
};
