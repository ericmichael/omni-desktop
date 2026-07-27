import { makeStyles, mergeClasses, Subtitle2, tokens, Toolbar, ToolbarButton } from '@fluentui/react-components';
import { ArrowLeft20Regular, LineHorizontal320Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

type TopAppBarProps = {
  title: ReactNode;
  /** Up one level within the surface. Wins over `onMenu` when both are set —
   *  a screen at depth shows back, not the drawer handle. */
  onBack?: () => void;
  /** Open the mobile nav drawer. The leading affordance at a surface root,
   *  where there is no "up" (the standard hamburger-at-root convention). */
  onMenu?: () => void;
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

export const TopAppBar = ({ title, onBack, onMenu, actions, className }: TopAppBarProps) => {
  const styles = useStyles();
  return (
    <Toolbar className={mergeClasses(styles.root, className)}>
      {onBack ? (
        <ToolbarButton aria-label="Back" icon={<ArrowLeft20Regular />} appearance="subtle" onClick={onBack} />
      ) : (
        onMenu && (
          <ToolbarButton
            aria-label="Open navigation"
            icon={<LineHorizontal320Regular />}
            appearance="subtle"
            onClick={onMenu}
          />
        )
      )}
      <Subtitle2 className={styles.title}>{title}</Subtitle2>
      {actions && <div className={styles.actions}>{actions}</div>}
    </Toolbar>
  );
};
