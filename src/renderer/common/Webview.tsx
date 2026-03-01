import { useCallback, useEffect, useRef } from 'react';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

export const Webview = ({
  src,
  onReady,
  showUnavailable = true,
}: {
  src?: string;
  onReady?: () => void;
  showUnavailable?: boolean;
}) => {
  const elementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onReadyRef = useRef(onReady);
  const readyEmittedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(750);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const clearRetryTimer = useCallback(() => {
    if (!retryTimerRef.current) {
      return;
    }
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const scheduleRetry = useCallback(() => {
    const el = elementRef.current;
    if (!el) {
      return;
    }
    clearRetryTimer();

    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(15_000, Math.round(retryDelayRef.current * 1.4));
    retryTimerRef.current = setTimeout(() => {
      if (isElectron) {
        (el as unknown as Electron.WebviewTag).reload();
      } else {
        // Reload iframe by resetting src
        (el as HTMLIFrameElement).src = (el as HTMLIFrameElement).src;
      }
    }, delay);
  }, [clearRetryTimer]);

  const callbackRef = useCallback(
    (node: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      elementRef.current = null;
      clearRetryTimer();
      retryDelayRef.current = 750;
      readyEmittedRef.current = false;

      if (!node || !src) {
        return;
      }

      elementRef.current = node;

      if (isElectron) {
        const el = node as unknown as Electron.WebviewTag;

        const onLoad = () => {
          clearRetryTimer();
          retryDelayRef.current = 750;

          if (!readyEmittedRef.current) {
            readyEmittedRef.current = true;
            onReadyRef.current?.();
          }
        };

        const onFailLoad = (...args: unknown[]) => {
          const errorCode = typeof args[1] === 'number' ? (args[1] as number) : null;
          const isMainFrame = typeof args[4] === 'boolean' ? (args[4] as boolean) : true;

          if (!isMainFrame) {
            return;
          }
          if (errorCode === -3) {
            return;
          }
          if (readyEmittedRef.current) {
            return;
          }

          scheduleRetry();
        };

        el.addEventListener('did-finish-load', onLoad);
        el.addEventListener('did-fail-load', onFailLoad);

        cleanupRef.current = () => {
          el.removeEventListener('did-finish-load', onLoad);
          el.removeEventListener('did-fail-load', onFailLoad);
        };
      } else {
        // Browser mode: use iframe events
        const iframe = node as HTMLIFrameElement;

        const onLoad = () => {
          clearRetryTimer();
          retryDelayRef.current = 750;

          if (!readyEmittedRef.current) {
            readyEmittedRef.current = true;
            onReadyRef.current?.();
          }
        };

        const onError = () => {
          if (readyEmittedRef.current) {
            return;
          }
          scheduleRetry();
        };

        iframe.addEventListener('load', onLoad);
        iframe.addEventListener('error', onError);

        cleanupRef.current = () => {
          iframe.removeEventListener('load', onLoad);
          iframe.removeEventListener('error', onError);
        };
      }
    },
    [clearRetryTimer, scheduleRetry, src]
  );

  if (!src) {
    if (!showUnavailable) {
      return null;
    }
    return (
      <div className="flex items-center justify-center w-full h-full border border-surface-border rounded-lg">
        <span className="text-fg-muted">Not available</span>
      </div>
    );
  }

  if (isElectron) {
    return <webview ref={callbackRef} src={src} style={{ width: '100%', height: '100%' }} />;
  }

  return (
    <iframe
      ref={callbackRef as React.RefCallback<HTMLIFrameElement>}
      src={src}
      style={{ width: '100%', height: '100%', border: 'none' }}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    />
  );
};
