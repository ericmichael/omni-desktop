import { AnimatePresence, motion } from 'framer-motion';
import type { MouseEvent, PropsWithChildren } from 'react';
import { useCallback } from 'react';

import { cn } from '@/renderer/ds/cn';

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  className?: string;
};

export const BottomSheet = ({ open, onClose, className, children }: PropsWithChildren<BottomSheetProps>) => {
  const onClickBackdrop = useCallback(
    (e: MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-40"
          onClick={onClickBackdrop}
        >
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0.1 }}
            className={cn(
              'absolute inset-x-0 bottom-0 top-[max(3rem,env(safe-area-inset-top,3rem))] flex flex-col overflow-hidden',
              'rounded-t-2xl border-t border-white/10 shadow-2xl backdrop-blur-[32px]',
              className
            )}
          >
            <div className="absolute inset-0 bg-surface-raised/95" />
            {/* Drag handle */}
            <div className="relative flex justify-center pt-2.5 pb-1 shrink-0">
              <div className="w-8 h-1 rounded-full bg-fg-subtle/40" />
            </div>
            <div className="relative flex-1 min-h-0">{children}</div>
            <div className="relative shrink-0 h-[env(safe-area-inset-bottom,0px)]" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
