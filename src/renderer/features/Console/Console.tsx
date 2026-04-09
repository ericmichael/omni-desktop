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
    <>
      {/* Mobile: bottom sheet */}
      <div className="sm:hidden">
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
            className="absolute inset-0 z-40 hidden sm:block"
            onClick={onClickOverlay}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
              className="absolute inset-4 bottom-[4.5rem] flex overflow-hidden rounded-xl border border-white/5 shadow-2xl backdrop-blur-[32px]"
            >
              <div className="absolute inset-0 bg-surface-raised/70" />
              <div className="relative w-full h-full min-h-0">
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
