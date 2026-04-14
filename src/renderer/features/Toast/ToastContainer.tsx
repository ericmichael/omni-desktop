import {
  Toast,
  ToastBody,
  Toaster,
  ToastTitle,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { memo, useCallback, useEffect } from 'react';

import type { ToastLevel } from '@/renderer/features/Toast/state';
import { $toasts, removeToast } from '@/renderer/features/Toast/state';

const LEVEL_TO_INTENT: Record<ToastLevel, 'info' | 'success' | 'warning' | 'error'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

export const ToastContainer = memo(() => {
  const toasterId = useId('app-toaster');
  const { dispatchToast } = useToastController(toasterId);

  // Watch the nanostore and dispatch Fluent toasts for each new entry.
  // This bridges the imperative addToast() API used by IPC/status listeners
  // into Fluent's toast system.
  const dispatchRef = useCallback(
    (toastData: { id: string; level: ToastLevel; title: string; description?: string; durationMs: number }) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{toastData.title}</ToastTitle>
          {toastData.description && <ToastBody>{toastData.description}</ToastBody>}
        </Toast>,
        {
          intent: LEVEL_TO_INTENT[toastData.level],
          timeout: toastData.durationMs > 0 ? toastData.durationMs : undefined,
          toastId: toastData.id,
        }
      );
      // Remove from the nanostore immediately — Fluent now owns the lifecycle
      removeToast(toastData.id);
    },
    [dispatchToast]
  );

  useEffect(() => {
    // Process any toasts already queued before this component mounted
    for (const t of $toasts.get()) {
      dispatchRef(t);
    }

    // Subscribe to future toasts
    const unsub = $toasts.subscribe((toasts) => {
      for (const t of toasts) {
        dispatchRef(t);
      }
    });
    return unsub;
  }, [dispatchRef]);

  return <Toaster toasterId={toasterId} position="bottom-end" />;
});
ToastContainer.displayName = 'ToastContainer';
