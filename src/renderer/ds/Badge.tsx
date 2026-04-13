import { Badge as FluentBadge, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { PropsWithChildren } from 'react';

type ColorScheme = 'default' | 'blue' | 'green' | 'purple' | 'red' | 'yellow' | 'sky' | 'orange';

type BadgeProps = {
  color?: ColorScheme;
  className?: string;
  /**
   * When true, constrain the badge to `maxWidth` (default 220px) and truncate
   * its text content with an ellipsis. Use for badges that carry user-generated
   * strings (milestone titles, branch names, etc.) in header rows.
   */
  truncate?: boolean;
  /** Max width when `truncate` is true. Defaults to 220px. */
  maxWidth?: number | string;
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
  /**
   * Fluent Badge root is `display: inline-flex; justify-content: center`.
   * With `overflow: hidden` + a max-width, a long text node gets centered
   * and clipped on both sides — which also defeats `text-overflow: ellipsis`
   * because the anonymous flex text item isn't a real element.
   *
   * We left-align when truncating so the clip happens on the right, and put
   * the actual ellipsis on a real child span (`truncateText` below).
   */
  truncateRoot: {
    flexShrink: 0,
    justifyContent: 'flex-start',
    overflow: 'hidden',
  },
  truncateText: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export const Badge = ({
  color = 'default',
  className,
  truncate,
  maxWidth = 220,
  children,
}: PropsWithChildren<BadgeProps>) => {
  const styles = useStyles();
  return (
    <FluentBadge
      appearance="tint"
      color={fluentColorMap[color]}
      shape="rounded"
      className={mergeClasses(styles.root, truncate && styles.truncateRoot, className)}
      style={truncate ? { maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth } : undefined}
    >
      {truncate ? <span className={styles.truncateText}>{children}</span> : children}
    </FluentBadge>
  );
};
