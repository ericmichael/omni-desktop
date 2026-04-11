import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MouseEvent } from 'react';
import { memo, useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { BottomSheet } from '@/renderer/ds';
import { ConsoleNotRunning } from '@/renderer/features/Console/ConsoleNotStarted';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $isConsoleOpen, $terminal } from '@/renderer/features/Console/state';

const onClose = () => {
  $isConsoleOpen.set(false);
};

const ConsoleContent = memo(() => {
  const terminal = useStore($terminal);
  return (
    <>
      {!terminal && <ConsoleNotRunning />}
      {terminal && <ConsoleStarted terminal={terminal} />}
    </>
  );
});
ConsoleContent.displayName = 'ConsoleContent';

const useStyles = makeStyles({
  mobileOnly: { '@media (min-width: 640px)': { display: 'none' } },
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 40,
    display: 'none',
    '@media (min-width: 640px)': { display: 'block' },
  },
  card: {
    position: 'absolute',
    inset: tokens.spacingVerticalL,
    bottom: '4.5rem',
    display: 'flex',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow64,
    backdropFilter: 'blur(32px)',
  },
  cardBg: { position: 'absolute', inset: 0, backgroundColor: tokens.colorNeutralBackground2, opacity: 0.7 },
  cardContent: { position: 'relative', width: '100%', height: '100%', minHeight: 0 },
});

export const Console = memo(() => {
  const isOpen = useStore($isConsoleOpen);
  const terminal = useStore($terminal);

  useHotkeys('esc', onClose);

  const onClickOverlay = useCallback((e: MouseEvent) => {
    if (e.target !== e.currentTarget) {
      e.stopPropagation();
      return;
    }
    onClose();
  }, []);

  const styles = useStyles();

  return (
    <>
      {/* Mobile: bottom sheet */}
      <div className={styles.mobileOnly}>
        <BottomSheet open={isOpen} onClose={onClose}>
          <ConsoleContent />
        </BottomSheet>
      </div>

      {/* Desktop: floating card */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={styles.overlay}
            onClick={onClickOverlay}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
              className={styles.card}
            >
              <div className={styles.cardBg} />
              <div className={styles.cardContent}>
                <ConsoleContent />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});
Console.displayName = 'Console';
