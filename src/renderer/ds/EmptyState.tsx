import { Body1, Caption1, makeStyles, mergeClasses } from '@fluentui/react-components';
import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    height: '100%',
    paddingLeft: '24px',
    paddingRight: '24px',
    textAlign: 'center',
  },
});

export const EmptyState = ({ title, description, action, className }: EmptyStateProps) => {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.root, className)}>
      <Body1>{title}</Body1>
      {description && <Caption1>{description}</Caption1>}
      {action}
    </div>
  );
};
