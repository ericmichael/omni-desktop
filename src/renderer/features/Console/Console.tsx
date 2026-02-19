import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import type { MouseEvent } from 'react';
import { memo, useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { ConsoleNotRunning } from '@/renderer/features/Console/ConsoleNotStarted';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $isConsoleOpen, $terminal } from '@/renderer/features/Console/state';

const onClose = () => {
  $isConsoleOpen.set(false);
};

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

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
          className="absolute inset-0 z-40"
          onClick={onClickOverlay}
        >
          <div className="absolute inset-4 bottom-[4.5rem] flex overflow-hidden rounded-lg border border-white/5 shadow-2xl backdrop-blur-[32px]">
            <div className="absolute inset-0 bg-surface-raised/70" />
            <div className="relative w-full h-full min-h-0">
              {!terminal && <ConsoleNotRunning />}
              {terminal && <ConsoleStarted terminal={terminal} />}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
Console.displayName = 'Console';
