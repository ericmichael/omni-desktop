import { Spinner as FluentSpinner } from '@fluentui/react-components';

type SpinnerProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
};

const sizeMap: Record<NonNullable<SpinnerProps['size']>, 'tiny' | 'extra-small' | 'small' | 'medium'> = {
  sm: 'tiny',
  md: 'extra-small',
  lg: 'small',
  xl: 'medium',
};

export const Spinner = ({ size = 'md', className }: SpinnerProps) => {
  return <FluentSpinner size={sizeMap[size]} className={className} />;
};
