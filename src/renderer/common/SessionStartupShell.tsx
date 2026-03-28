import { AnimatePresence, motion } from 'framer-motion';
import { memo } from 'react';

import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { cn, Heading } from '@/renderer/ds';

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

export const SessionStartupShell = memo(({ eyebrow, title, description, children, tone = 'default', className, contentClassName }: SessionStartupShellProps) => {
  const toneClasses = tone === 'danger' ? 'border-red-400/20 bg-red-400/5' : 'border-surface-border bg-surface/90';

  return (
    <BodyContainer className="p-6">
      <BodyContent className="justify-center items-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${tone}-${title}-${description}`}
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn('flex w-full max-w-3xl flex-col gap-6 rounded-2xl border px-6 py-6 shadow-sm backdrop-blur-sm', toneClasses, className)}
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">{eyebrow}</span>
              <Heading size="md">{title}</Heading>
              <p className="max-w-xl text-sm text-fg-muted text-center">{description}</p>
            </div>
            <div className={cn('w-full', contentClassName)}>{children}</div>
          </motion.div>
        </AnimatePresence>
      </BodyContent>
    </BodyContainer>
  );
});
SessionStartupShell.displayName = 'SessionStartupShell';
