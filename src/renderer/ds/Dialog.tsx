import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'framer-motion';
import type { PropsWithChildren } from 'react';
import { forwardRef, useCallback } from 'react';

import { cn } from '@/renderer/ds/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export const DialogOverlay = forwardRef<HTMLDivElement, DialogPrimitive.DialogOverlayProps>(
  ({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay ref={ref} asChild {...props}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className={cn('fixed inset-0 z-50 backdrop-blur-2xl', className)}
      >
        <div className="absolute inset-0 bg-surface/70" />
      </motion.div>
    </DialogPrimitive.Overlay>
  )
);
DialogOverlay.displayName = 'DialogOverlay';

export const DialogContent = forwardRef<HTMLDivElement, DialogPrimitive.DialogContentProps>(
  ({ className, children, ...props }, ref) => (
    <DialogPrimitive.Portal forceMount>
      <DialogOverlay />
      <DialogPrimitive.Content ref={ref} asChild {...props}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0.1 }}
          className={cn(
            'fixed inset-0 z-50 m-auto h-fit max-h-[85vh] w-full max-w-lg',
            'rounded-xl border border-surface-border bg-surface-raised shadow-2xl',
            'overflow-y-auto',
            'focus:outline-none',
            className
          )}
        >
          {children}
        </motion.div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
);
DialogContent.displayName = 'DialogContent';

export const DialogHeader = ({ className, children }: PropsWithChildren<{ className?: string }>) => (
  <div className={cn('flex items-center justify-between px-6 pt-6 pb-2', className)}>
    <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-fg">{children}</DialogPrimitive.Title>
    <DialogPrimitive.Close className="rounded-lg p-1.5 text-fg-muted hover:bg-white/5 hover:text-fg transition-colors cursor-pointer">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.193 2.99391 11.557 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.557 12.0062 11.193 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z"
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </svg>
    </DialogPrimitive.Close>
  </div>
);

export const DialogBody = ({ className, children }: PropsWithChildren<{ className?: string }>) => (
  <div className={cn('px-6 py-4', className)}>{children}</div>
);

export const DialogFooter = ({ className, children }: PropsWithChildren<{ className?: string }>) => (
  <div className={cn('flex items-center px-6 pb-6 pt-2', className)}>{children}</div>
);

export const AnimatedDialog = ({
  open,
  onClose,
  children,
}: PropsWithChildren<{ open: boolean; onClose?: () => void }>) => {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onClose?.();
      }
    },
    [onClose]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <AnimatePresence>{open && children}</AnimatePresence>
    </Dialog>
  );
};
