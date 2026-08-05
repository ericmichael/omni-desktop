import Linkify from 'linkify-react';
import type { Opts as LinkifyOpts } from 'linkifyjs';
import type { HTMLAttributes, PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds/cn';

const linkifyOptions: LinkifyOpts = {
  target: '_blank',
  rel: 'noopener noreferrer',
  validate: (value) => /^https?:\/\//.test(value),
};

type Props = {
  isLoading: boolean;
} & HTMLAttributes<HTMLDivElement>;

export const XTermLogViewerStatusIndicator = ({
  isLoading,
  children,
  className,
  ...rest
}: PropsWithChildren<Props>) => {
  return (
    <div
      className={cn(
        'bg-card rounded-xl select-none pl-4 pr-4 pt-1 pb-1 opacity-80 border border-border shadow-lg',
        className
      )}
      {...rest}
    >
      <span
        data-loading={isLoading}
        className="[&_a]:font-semibold [&_a:hover]:underline data-[loading=true]:after:inline-block data-[loading=true]:after:animate-ellipsis"
      >
        <Linkify options={linkifyOptions}>{children}</Linkify>
      </span>
    </div>
  );
};
