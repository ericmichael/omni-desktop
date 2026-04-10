import { Button as FluentButton, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';

type FABProps = {
  icon: ReactNode;
  onClick: () => void;
  'aria-label': string;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    position: 'fixed',
    right: '16px',
    bottom: '80px',
    zIndex: 30,
    width: '56px',
    height: '56px',
    minWidth: '56px',
    borderRadius: '16px',
    boxShadow: tokens.shadow16,
  },
});

export const FAB = ({ icon, onClick, className, ...rest }: FABProps) => {
  const styles = useStyles();
  return (
    <FluentButton
      appearance="primary"
      shape="square"
      icon={icon as ReactElement}
      onClick={onClick}
      aria-label={rest['aria-label']}
      className={mergeClasses(styles.root, className)}
    />
  );
};
