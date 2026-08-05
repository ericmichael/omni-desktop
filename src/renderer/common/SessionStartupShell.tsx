import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';

const fadeVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

type SessionStartupShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
  contentClassName?: string;
};

export const SessionStartupShell = memo(
  ({
    eyebrow,
    title,
    description,
    children,
    tone = 'default',
    className,
    contentClassName,
  }: SessionStartupShellProps) => {
    const toneClasses =
      tone === 'danger' ? 'border-destructive/20 bg-destructive/5' : 'border-transparent bg-transparent';

    return (
      <div className="relative flex h-full min-h-0 w-full flex-col items-center gap-4 p-6">
        <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4">
          <AnimatePresence mode="wait">
            <motion.div
              key={`${tone}-${title}-${description}`}
              variants={fadeVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className={cn(
                'flex w-full max-w-3xl flex-col gap-6 rounded-2xl border px-6 py-6',
                toneClasses,
                className
              )}
            >
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{eyebrow}</span>
                <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
                <p className="max-w-xl text-center text-sm text-muted-foreground">{description}</p>
              </div>
              <div className={cn('w-full', contentClassName)}>{children}</div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    );
  }
);
SessionStartupShell.displayName = 'SessionStartupShell';
