import {
  Button,
  Toast,
  ToastBody,
  Toaster,
  ToastFooter,
  ToastTitle,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { Copy20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect } from 'react';

import type { ToastLevel } from '@/renderer/features/Toast/state';
import { $toasts, removeToast } from '@/renderer/features/Toast/state';

const copyToClipboard = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for rare cases where the Clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
  }
};

const LEVEL_TO_INTENT: Record<ToastLevel, 'info' | 'success' | 'warning' | 'error'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

export const ToastContainer = memo(() => {
  const toasterId = useId('app-toaster');
  const { dispatchToast, dismissToast } = useToastController(toasterId);

  // Watch the nanostore and dispatch Fluent toasts for each new entry.
  // This bridges the imperative addToast() API used by IPC/status listeners
  // into Fluent's toast system.
  const dispatchRef = useCallback(
    (toastData: {
      id: string;
      level: ToastLevel;
      title: string;
      description?: string;
      copyText?: string;
      durationMs: number;
    }) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{toastData.title}</ToastTitle>
          {toastData.description && <ToastBody>{toastData.description}</ToastBody>}
          {toastData.copyText && (
            <ToastFooter>
              <Button
                size="small"
                icon={<Copy20Regular />}
                onClick={() => void copyToClipboard(toastData.copyText!)}
              >
                Copy error
              </Button>
              <Button size="small" onClick={() => dismissToast(toastData.id)}>
                Dismiss
              </Button>
            </ToastFooter>
          )}
        </Toast>,
        {
          intent: LEVEL_TO_INTENT[toastData.level],
          // durationMs <= 0 means "do not auto-dismiss" — user must close it manually.
          timeout: toastData.durationMs > 0 ? toastData.durationMs : -1,
          toastId: toastData.id,
        }
      );
      // Remove from the nanostore immediately — Fluent now owns the lifecycle
      removeToast(toastData.id);
    },
    [dispatchToast, dismissToast]
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

  return <Toaster toasterId={toasterId} position="bottom-end" pauseOnHover pauseOnWindowBlur />;
});
ToastContainer.displayName = 'ToastContainer';
