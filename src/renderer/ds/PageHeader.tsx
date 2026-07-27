import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { LineHorizontal320Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import { Subtitle2 } from '@/renderer/ds/Text';

type PageHeaderProps = {
  title: string;
  /** Open the mobile nav drawer. Surfaces pass this on mobile only; desktop
   *  leaves it undefined, since the sidebar is always present. */
  onMenu?: () => void;
  /** Icon buttons / controls rendered at the right edge. */
  actions?: ReactNode;
};

/**
 * The standard header for a rail-level tab (or its list pane). Geometry
 * matches the Work sidebar header so every tab opens with the same
 * top-left title placement.
 */
const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
    flexShrink: 0,
  },
  /* The drawer handle carries its own optical padding — pull the row's in
     so the title lands where it does without one. */
  rootWithMenu: {
    paddingLeft: tokens.spacingHorizontalXS,
  },
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export const PageHeader = ({ title, onMenu, actions }: PageHeaderProps) => {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.root, onMenu && styles.rootWithMenu)}>
      {onMenu && (
        <Button
          aria-label="Open navigation"
          icon={<LineHorizontal320Regular />}
          appearance="subtle"
          size="small"
          onClick={onMenu}
        />
      )}
      <Subtitle2 className={styles.title}>{title}</Subtitle2>
      {actions}
    </div>
  );
};
