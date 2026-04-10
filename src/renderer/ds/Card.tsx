import { Card as FluentCard, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';

type CardProps = {
  divided?: boolean;
  className?: string;
};

const useStyles = makeStyles({
  root: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderColor: tokens.colorNeutralStroke1,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '8px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  divided: {
    padding: '0',
    gap: '0',
    '& > *': {
      padding: '16px',
    },
    '& > * + *': {
      borderTopWidth: '1px',
      borderTopStyle: 'solid',
      borderTopColor: tokens.colorNeutralStroke1,
    },
  },
});

export const Card = ({ divided, className, children }: PropsWithChildren<CardProps>) => {
  const styles = useStyles();
  return (
    <FluentCard className={mergeClasses(styles.root, divided && styles.divided, className)}>{children}</FluentCard>
  );
};
