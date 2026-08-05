import type { MotionProps } from 'motion/react';
import { motion } from 'motion/react';
import type { ElementType, JSX } from 'react';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';

type MotionHTMLProps = MotionProps & Record<string, unknown>;

const motionComponentCache = new Map<keyof JSX.IntrinsicElements, React.ComponentType<MotionHTMLProps>>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({ children, as: Component = 'p', className, duration = 2 }: TextShimmerProps) => {
  const MotionComponent = getMotionComponent(Component as keyof JSX.IntrinsicElements);

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn('text-shimmer relative inline-block bg-clip-text text-transparent', className)}
      initial={{ backgroundPosition: '100% center' }}
      transition={{
        duration,
        ease: 'linear',
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
