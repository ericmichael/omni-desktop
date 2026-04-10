import { Divider as FluentDivider } from '@fluentui/react-components';

type DividerProps = {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
};

export const Divider = ({ orientation = 'horizontal', className }: DividerProps) => {
  return <FluentDivider vertical={orientation === 'vertical'} className={className} />;
};
