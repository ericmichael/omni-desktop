import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import Linkify from 'linkify-react';
import type { Opts as LinkifyOpts } from 'linkifyjs';
import type { HTMLAttributes, PropsWithChildren } from 'react';

const linkifyOptions: LinkifyOpts = {
  target: '_blank',
  rel: 'noopener noreferrer',
  validate: (value) => /^https?:\/\//.test(value),
};

const useStyles = makeStyles({
  root: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusLarge,
    userSelect: 'none',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '4px',
    paddingBottom: '4px',
    opacity: 0.8,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow16,
  },
});

type Props = {
  isLoading: boolean;
} & HTMLAttributes<HTMLDivElement>;

export const XTermLogViewerStatusIndicator = ({
  isLoading,
  children,
  className,
  ...rest
}: PropsWithChildren<Props>) => {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(styles.root, className)}
      {...rest}
    >
      <span
        data-loading={isLoading}
        className="[&_a]:font-semibold [&_a:hover]:underline data-[loading=true]:after:inline-block data-[loading=true]:after:animate-ellipsis data-[loading=true]:after:content-['...']"
      >
        <Linkify options={linkifyOptions}>{children}</Linkify>
      </span>
    </div>
  );
};
