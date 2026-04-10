import { makeStyles, mergeClasses, Subtitle1, Subtitle2, Title1, Title2, Title3 } from '@fluentui/react-components';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';

type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4';

type HeadingProps = {
  as?: HeadingLevel;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & HTMLAttributes<HTMLHeadingElement>;

const sizeToComponent = {
  xs: Subtitle2,
  sm: Subtitle1,
  md: Title3,
  lg: Title2,
  xl: Title1,
};

const useStyles = makeStyles({
  root: {
    letterSpacing: '-0.01em',
  },
});

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ as: tag = 'h2', size = 'md', className, children, ...props }, ref) => {
    const styles = useStyles();
    const Component = sizeToComponent[size];

    return (
      <Component ref={ref} as={tag} className={mergeClasses(styles.root, className)} {...props}>
        {children}
      </Component>
    );
  }
);

Heading.displayName = 'Heading';
