import { Badge as FluentBadge, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';

type ColorScheme = 'default' | 'blue' | 'green' | 'purple' | 'red' | 'yellow' | 'sky' | 'orange';

type BadgeProps = {
  color?: ColorScheme;
  className?: string;
};

const fluentColorMap: Record<ColorScheme, 'informative' | 'brand' | 'success' | 'important' | 'warning' | 'severe' | 'subtle'> = {
  default: 'subtle',
  blue: 'informative',
  green: 'success',
  purple: 'brand',
  red: 'important',
  yellow: 'warning',
  sky: 'informative',
  orange: 'severe',
};

const useStyles = makeStyles({
  root: {
    fontWeight: tokens.fontWeightSemibold,
  },
});

export const Badge = ({ color = 'default', className, children }: PropsWithChildren<BadgeProps>) => {
  const styles = useStyles();
  return (
    <FluentBadge
      appearance="tint"
      color={fluentColorMap[color]}
      shape="rounded"
      className={mergeClasses(styles.root, className)}
    >
      {children}
    </FluentBadge>
  );
};
