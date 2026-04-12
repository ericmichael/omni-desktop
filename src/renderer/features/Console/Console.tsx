import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MouseEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { BottomSheet } from '@/renderer/ds';
import { ConsoleNotRunning } from '@/renderer/features/Console/ConsoleNotStarted';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $isConsoleOpen, $terminals } from '@/renderer/features/Console/state';

const onClose = () => {
  $isConsoleOpen.set(false);
};

const ConsoleContent = memo(() => {
  const terminals = useStore($terminals);
  return (
    <>
      {terminals.length === 0 && <ConsoleNotRunning />}
      {terminals.length > 0 && <ConsoleStarted />}
    </>
  );
});
ConsoleContent.displayName = 'ConsoleContent';

const useStyles = makeStyles({
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 40,
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
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

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
      {isMobile && (
        <BottomSheet open={isOpen} onClose={onClose}>
          <ConsoleContent />
        </BottomSheet>
      )}

      <AnimatePresence>
        {isOpen && !isMobile && (
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
