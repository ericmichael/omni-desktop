import { motion } from 'framer-motion';
import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';

type Props = {
  providerLabel: string;
  modelLabel: string;
  /** Already masked (`sk-…abc4`); omitted for OAuth / local providers. */
  maskedKey?: string | undefined;
  onFinish: () => void;
};

/**
 * The handshake moment — the one screen in setup that celebrates instead of
 * configures. Check draws in, then the connection card materializes.
 * framer-motion inherits the app-level reduced-motion config.
 */
export const OnboardingConnectedStep = memo(({ providerLabel, modelLabel, maskedKey, onFinish }: Props) => {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <motion.svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        fill="none"
        className="text-success"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      >
        <motion.circle
          cx="28"
          cy="28"
          r="25"
          stroke="currentColor"
          strokeWidth="3"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />

        <motion.path
          d="M17 29.5 L24.5 37 L39 20.5"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, delay: 0.35, ease: 'easeOut' }}
        />
      </motion.svg>

      <motion.div
        className="flex flex-col gap-1 items-center w-full p-4 rounded-xl border border-border bg-card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.55, ease: 'easeOut' }}
      >
        <span className="text-sm font-semibold">Connected to {providerLabel}</span>
        <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>{modelLabel}</span>
        {maskedKey && <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>{maskedKey}</span>}
      </motion.div>

      <motion.div
        className="w-full flex justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.75 }}
      >
        <Button variant="default" onClick={onFinish}>
          Start chatting
        </Button>
      </motion.div>
    </div>
  );
});
OnboardingConnectedStep.displayName = 'OnboardingConnectedStep';
