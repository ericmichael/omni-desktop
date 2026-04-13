import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

export type WebviewHandle = {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  stop: () => void;
  executeScript: (code: string) => Promise<unknown>;
  /**
   * Inject a stylesheet into the embedded document. Returns a key that can be
   * passed to `removeInsertedCSS`. In Electron `<webview>` this works across
   * origins via the chromium `insertCSS` API. In iframe (browser) mode this
   * is a no-op and returns null.
   */
  insertCSS: (css: string) => Promise<string | null>;
  removeInsertedCSS: (key: string) => Promise<void>;
};

export type ConsoleMessage = {
  level: 'log' | 'warn' | 'error';
  message: string;
};

export const Webview = forwardRef<WebviewHandle, {
  src?: string;
  onReady?: () => void;
  onConsoleMessage?: (msg: ConsoleMessage) => void;
  onNavigate?: (url: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  onTitleChange?: (title: string) => void;
  onError?: (error: { code: number; description: string; url: string }) => void;
  showUnavailable?: boolean;
}>(({
  src,
  onReady,
  onConsoleMessage,
  onNavigate,
  onLoadingChange,
  onTitleChange,
  onError,
  showUnavailable = true,
}, handleRef) => {
  const elementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onReadyRef = useRef(onReady);
  const onConsoleRef = useRef(onConsoleMessage);
  const onNavigateRef = useRef(onNavigate);
  const onLoadingRef = useRef(onLoadingChange);
  const onTitleRef = useRef(onTitleChange);
  const onErrorRef = useRef(onError);
  const readyEmittedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(750);

  useEffect(() => {
 onReadyRef.current = onReady; 
}, [onReady]);
  useEffect(() => {
 onConsoleRef.current = onConsoleMessage; 
}, [onConsoleMessage]);
  useEffect(() => {
 onNavigateRef.current = onNavigate; 
}, [onNavigate]);
  useEffect(() => {
 onLoadingRef.current = onLoadingChange; 
}, [onLoadingChange]);
  useEffect(() => {
 onTitleRef.current = onTitleChange; 
}, [onTitleChange]);
  useEffect(() => {
 onErrorRef.current = onError; 
}, [onError]);

  useImperativeHandle(handleRef, () => ({
    reload: () => {
      const el = elementRef.current;
      if (!el) {
return;
}
      if (isElectron) {
        (el as unknown as Electron.WebviewTag).reload();
      } else {
        (el as HTMLIFrameElement).src = (el as HTMLIFrameElement).src;
      }
    },
    goBack: () => {
      const el = elementRef.current;
      if (!el) {
return;
}
      if (isElectron) {
        (el as unknown as Electron.WebviewTag).goBack();
      } else {
        try {
 (el as HTMLIFrameElement).contentWindow?.history.back(); 
} catch { /* cross-origin */ }
      }
    },
    goForward: () => {
      const el = elementRef.current;
      if (!el) {
return;
}
      if (isElectron) {
        (el as unknown as Electron.WebviewTag).goForward();
      } else {
        try {
 (el as HTMLIFrameElement).contentWindow?.history.forward(); 
} catch { /* cross-origin */ }
      }
    },
    stop: () => {
      const el = elementRef.current;
      if (!el) {
return;
}
      if (isElectron) {
        (el as unknown as Electron.WebviewTag).stop();
      } else {
        try {
 (el as HTMLIFrameElement).contentWindow?.stop(); 
} catch { /* cross-origin */ }
      }
    },
    executeScript: async (code: string): Promise<unknown> => {
      const el = elementRef.current;
      if (!el) {
return undefined;
}
      if (isElectron) {
        return (el as unknown as Electron.WebviewTag).executeJavaScript(code);
      }
      try {
        const win = (el as HTMLIFrameElement).contentWindow as (Window & { eval: (code: string) => unknown }) | null;
        if (!win) {
return undefined;
}
        return win.eval(code);
      } catch (e) {
        return String(e);
      }
    },
    insertCSS: async (css: string): Promise<string | null> => {
      const el = elementRef.current;
      if (!el || !isElectron) {
return null;
}
      try {
        return await (el as unknown as Electron.WebviewTag).insertCSS(css);
      } catch {
        return null;
      }
    },
    removeInsertedCSS: async (key: string): Promise<void> => {
      const el = elementRef.current;
      if (!el || !isElectron) {
return;
}
      try {
        await (el as unknown as Electron.WebviewTag).removeInsertedCSS(key);
      } catch {
        // ignore — webview may have navigated away
      }
    },
  }), []);

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

        const onStartLoad = () => {
          onLoadingRef.current?.(true);
        };

        const onLoad = () => {
          clearRetryTimer();
          retryDelayRef.current = 750;
          onLoadingRef.current?.(false);

          if (!readyEmittedRef.current) {
            readyEmittedRef.current = true;
            onReadyRef.current?.();
          }

          // Read page title
          el.getTitle?.()
            ? onTitleRef.current?.(el.getTitle())
            : void el.executeJavaScript?.('document.title').then((t: string) => onTitleRef.current?.(t)).catch(() => {});
        };

        const onFailLoad = (event: unknown) => {
          const e = event as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
          const errorCode = e.errorCode ?? null;
          const isMainFrame = e.isMainFrame ?? true;

          if (!isMainFrame) {
return;
}
          if (errorCode === -3) {
return;
} // ERR_ABORTED
          onLoadingRef.current?.(false);

          if (readyEmittedRef.current) {
            onErrorRef.current?.({ code: errorCode ?? -1, description: e.errorDescription ?? 'Load failed', url: e.validatedURL ?? '' });
            return;
          }
          scheduleRetry();
        };

        const onConsole = (event: unknown) => {
          const e = event as { level?: number; message?: string };
          const level = e.level === 2 ? 'error' : e.level === 1 ? 'warn' : 'log';
          onConsoleRef.current?.({ level, message: e.message ?? '' });
        };

        const onNavigateEvent = (event: unknown) => {
          const e = event as { url?: string; isMainFrame?: boolean };
          if (e.isMainFrame === false) {
return;
}
          if (e.url) {
onNavigateRef.current?.(e.url);
}
        };

        const onTitleUpdate = (event: unknown) => {
          const e = event as { title?: string };
          if (e.title) {
onTitleRef.current?.(e.title);
}
        };

        el.addEventListener('did-start-loading', onStartLoad);
        el.addEventListener('did-finish-load', onLoad);
        el.addEventListener('did-fail-load', onFailLoad);
        el.addEventListener('console-message', onConsole);
        el.addEventListener('did-navigate', onNavigateEvent);
        el.addEventListener('did-navigate-in-page', onNavigateEvent);
        el.addEventListener('page-title-updated', onTitleUpdate);

        cleanupRef.current = () => {
          el.removeEventListener('did-start-loading', onStartLoad);
          el.removeEventListener('did-finish-load', onLoad);
          el.removeEventListener('did-fail-load', onFailLoad);
          el.removeEventListener('console-message', onConsole);
          el.removeEventListener('did-navigate', onNavigateEvent);
          el.removeEventListener('did-navigate-in-page', onNavigateEvent);
          el.removeEventListener('page-title-updated', onTitleUpdate);
        };
      } else {
        // Browser mode: use iframe events
        const iframe = node as HTMLIFrameElement;

        onLoadingRef.current?.(true);

        const onLoad = () => {
          clearRetryTimer();
          retryDelayRef.current = 750;
          onLoadingRef.current?.(false);

          if (!readyEmittedRef.current) {
            readyEmittedRef.current = true;
            onReadyRef.current?.();
          }

          // Report the navigated URL and title back
          try {
            const href = iframe.contentWindow?.location.href;
            if (href && href !== 'about:blank') {
              onNavigateRef.current?.(href);
            }
            const title = iframe.contentDocument?.title;
            if (title) {
onTitleRef.current?.(title);
}
          } catch { /* cross-origin */ }
        };

        const onIframeError = () => {
          onLoadingRef.current?.(false);
          if (readyEmittedRef.current) {
            onErrorRef.current?.({ code: -1, description: 'Failed to load page', url: iframe.src });
            return;
          }
          scheduleRetry();
        };

        const onMessage = (event: MessageEvent) => {
          if (event.source !== iframe.contentWindow) {
return;
}
          const data = event.data as { type?: string; level?: string; message?: string; url?: string; title?: string } | null;
          if (data?.type === '__preview_console__') {
            const level = data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log';
            onConsoleRef.current?.({ level, message: data.message ?? '' });
          } else if (data?.type === '__preview_navigate__' && data.url) {
            onNavigateRef.current?.(data.url);
          } else if (data?.type === '__preview_title__' && data.title) {
            onTitleRef.current?.(data.title);
          }
        };

        iframe.addEventListener('load', onLoad);
        iframe.addEventListener('error', onIframeError);
        window.addEventListener('message', onMessage);

        cleanupRef.current = () => {
          iframe.removeEventListener('load', onLoad);
          iframe.removeEventListener('error', onIframeError);
          window.removeEventListener('message', onMessage);
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
});
Webview.displayName = 'Webview';
