import { makeStyles, tokens } from '@fluentui/react-components';
import { motion } from 'framer-motion';
import { memo } from 'react';

import { Body1Strong, Button, Caption1 } from '@/renderer/ds';

type Props = {
  providerLabel: string;
  modelLabel: string;
  /** Already masked (`sk-…abc4`); omitted for OAuth / local providers. */
  maskedKey?: string | undefined;
  onFinish: () => void;
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', textAlign: 'center' },
  check: { color: tokens.colorPaletteGreenForeground1 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    alignItems: 'center',
    width: '100%',
    padding: '16px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  detail: { color: tokens.colorNeutralForeground2 },
  cta: { width: '100%', display: 'flex', justifyContent: 'center' },
});

/**
 * The handshake moment — the one screen in setup that celebrates instead of
 * configures. Check draws in, then the connection card materializes.
 * framer-motion inherits the app-level reduced-motion config.
 */
export const OnboardingConnectedStep = memo(({ providerLabel, modelLabel, maskedKey, onFinish }: Props) => {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <motion.svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        fill="none"
        className={styles.check}
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
        className={styles.card}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.55, ease: 'easeOut' }}
      >
        <Body1Strong>Connected to {providerLabel}</Body1Strong>
        <Caption1 className={styles.detail}>{modelLabel}</Caption1>
        {maskedKey && <Caption1 className={styles.detail}>{maskedKey}</Caption1>}
      </motion.div>

      <motion.div
        className={styles.cta}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.75 }}
      >
        <Button variant="primary" onClick={onFinish}>
          Start chatting
        </Button>
      </motion.div>
    </div>
  );
});
OnboardingConnectedStep.displayName = 'OnboardingConnectedStep';
