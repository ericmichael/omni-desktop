import { Caption1Strong, makeStyles, mergeClasses } from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';

type SectionLabelProps = {
  className?: string;
};

const useStyles = makeStyles({
  root: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
});

export const SectionLabel = ({ className, children }: PropsWithChildren<SectionLabelProps>) => {
  const styles = useStyles();
  return (
    <Caption1Strong className={mergeClasses(styles.root, className)}>{children}</Caption1Strong>
  );
};
