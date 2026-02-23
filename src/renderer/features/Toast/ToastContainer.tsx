import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useRef } from 'react';
import { PiCheckCircleFill, PiInfoFill, PiWarningFill, PiXBold, PiXCircleFill } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import type { Toast, ToastLevel } from '@/renderer/features/Toast/state';
import { $toasts, removeToast } from '@/renderer/features/Toast/state';

const LEVEL_STYLES: Record<ToastLevel, { icon: React.ReactNode; border: string; iconColor: string }> = {
  info: {
    icon: <PiInfoFill />,
    border: 'border-blue-500/30',
    iconColor: 'text-blue-400',
  },
  success: {
    icon: <PiCheckCircleFill />,
    border: 'border-green-500/30',
    iconColor: 'text-green-400',
  },
  warning: {
    icon: <PiWarningFill />,
    border: 'border-yellow-500/30',
    iconColor: 'text-yellow-400',
  },
  error: {
    icon: <PiXCircleFill />,
    border: 'border-red-500/30',
    iconColor: 'text-red-400',
  },
};

const ToastItem = memo(({ toast }: { toast: Toast }) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const style = LEVEL_STYLES[toast.level];

  useEffect(() => {
    if (toast.durationMs > 0) {
      timerRef.current = setTimeout(() => {
        removeToast(toast.id);
      }, toast.durationMs);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [toast.id, toast.durationMs]);

  const onDismiss = useCallback(() => {
    removeToast(toast.id);
  }, [toast.id]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: 'spring', duration: 0.35, bounce: 0.1 }}
      className={cn(
        'pointer-events-auto w-80 rounded-lg border bg-surface-raised shadow-lg',
        'flex items-start gap-2.5 px-3.5 py-3',
        style.border
      )}
    >
      <span className={cn('mt-0.5 text-sm shrink-0', style.iconColor)}>{style.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-xs text-fg-muted leading-relaxed">{toast.description}</p>}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 mt-0.5 p-0.5 rounded text-fg-subtle hover:text-fg transition-colors cursor-pointer"
      >
        <PiXBold className="text-[10px]" />
      </button>
    </motion.div>
  );
});
ToastItem.displayName = 'ToastItem';

export const ToastContainer = memo(() => {
  const toasts = useStore($toasts);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
});
ToastContainer.displayName = 'ToastContainer';
