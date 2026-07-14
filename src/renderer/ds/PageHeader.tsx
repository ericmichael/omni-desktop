import { makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { Subtitle2 } from '@/renderer/ds/Text';

type PageHeaderProps = {
  title: string;
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
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export const PageHeader = ({ title, actions }: PageHeaderProps) => {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <Subtitle2 className={styles.title}>{title}</Subtitle2>
      {actions}
    </div>
  );
};
