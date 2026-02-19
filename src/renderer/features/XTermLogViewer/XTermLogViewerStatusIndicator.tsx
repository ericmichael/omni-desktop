import Linkify from 'linkify-react';
import type { Opts as LinkifyOpts } from 'linkifyjs';
import type { HTMLAttributes, PropsWithChildren } from 'react';

import { cn } from '@/renderer/ds';

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
        'bg-surface-raised rounded-lg select-none px-3 py-1 opacity-80 border border-surface-border shadow-lg',
        className
      )}
      {...rest}
    >
      <span
        data-loading={isLoading}
        className={cn(
          '[&_a]:font-semibold [&_a:hover]:underline',
          'data-[loading=true]:after:inline-block data-[loading=true]:after:animate-ellipsis data-[loading=true]:after:content-["…"]'
        )}
      >
        <Linkify options={linkifyOptions}>{children}</Linkify>
      </span>
    </div>
  );
};
