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
      // `text-shimmer` must stay OUTSIDE the cn() merge: tailwind-merge
      // classifies it as a text-color utility, so `text-transparent` (or any
      // caller-supplied text color) would delete it and the label paints
      // invisibly — transparent text with no gradient to clip. The class
      // itself already sets bg-clip-text + color:transparent.
      className={`text-shimmer ${cn('relative inline-block', className)}`}
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
