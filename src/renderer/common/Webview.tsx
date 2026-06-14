import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import {
  DEFAULT_WEBVIEW_MAX_INITIAL_RETRIES,
  DEFAULT_WEBVIEW_RETRY_BASE_DELAY_MS,
  DEFAULT_WEBVIEW_RETRY_MAX_DELAY_MS,
  getRetryDelayMs,
  isAbortErrorCode,
  shouldRetryInitialLoad,
} from '@/lib/webview-navigation';
import {
  getWebviewFallbackDiagnostics,
  openInBrowserTab,
  type WebviewLoadError,
} from '@/renderer/common/webview-fallback';
import { registerApp, unregisterApp, updateApp } from '@/renderer/features/AppControl/live-registry';
import { resolveProxiedSrc, unproxyUrl } from '@/renderer/services/proxy-resolver';
import type { AppHandleId, AppRegistrationPayload } from '@/shared/app-control-types';
import { isControllableKind } from '@/shared/app-control-types';

const isElectron = typeof window !== 'undefined' && 'electron' in window;

const embeddedUserAgent = (() => {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const normalized = navigator.userAgent
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s+omni-desktop\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized || undefined;
})();

/**
 * Metadata a surface passes to `<Webview>` so it can self-register with the
 * app-control registry. Omit to opt out (e.g. transient previews).
 */
export type WebviewRegistryProps = {
  handleId: AppHandleId;
  appId: AppRegistrationPayload['appId'];
  kind: AppRegistrationPayload['kind'];
  scope: AppRegistrationPayload['scope'];
  tabId?: string;
  label: string;
  /** For `builtin-browser` surfaces — routes `window.open` / target=_blank. */
  browserTabsetId?: string;
};

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
  /**
   * Start / update an in-page find. Subsequent calls with `findNext: true`
   * advance to the next match. No-op in iframe mode.
   */
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => void;
  /** Stop the active find. `action` maps to Electron's `stopFindInPage` actions. */
  stopFindInPage: (action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  /** Open Chromium DevTools against the guest page (Electron only). */
  openDevTools: () => void;
};

export type ConsoleMessage = {
  level: 'log' | 'warn' | 'error';
  message: string;
};

export type FoundInPageResult = {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
};

/** Subset of Electron webview `context-menu` params we surface to callers. */
export type ContextMenuParams = {
  x: number;
  y: number;
  linkURL?: string;
  linkText?: string;
  pageURL?: string;
  frameURL?: string;
  srcURL?: string;
  mediaType?: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin';
  hasImageContents?: boolean;
  isEditable?: boolean;
  selectionText?: string;
  titleText?: string;
  editFlags?: {
    canUndo?: boolean;
    canRedo?: boolean;
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
};

export const Webview = forwardRef<
  WebviewHandle,
  {
    src?: string;
    onReady?: () => void;
    onConsoleMessage?: (msg: ConsoleMessage) => void;
    onNavigate?: (url: string) => void;
    onLoadingChange?: (loading: boolean) => void;
    onTitleChange?: (title: string) => void;
    onFaviconChange?: (favicon: string) => void;
    onFoundInPage?: (result: FoundInPageResult) => void;
    onContextMenu?: (params: ContextMenuParams) => void;
    onError?: (error: WebviewLoadError) => void;
    maxInitialRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    showUnavailable?: boolean;
    /** If provided, this webview registers itself with the app-control registry. */
    registry?: WebviewRegistryProps;
    /**
     * Electron `<webview partition="…">`. Scopes cookies / localStorage / cache
     * to the given profile. Names starting with `persist:` persist to disk; any
     * other name is in-memory only (incognito). No-op in browser/iframe mode.
     */
    partition?: string;
  }
>(
  (
    {
      src,
      onReady,
      onConsoleMessage,
      onNavigate,
      onLoadingChange,
      onTitleChange,
      onFaviconChange,
      onFoundInPage,
      onContextMenu,
      onError,
      maxInitialRetries = DEFAULT_WEBVIEW_MAX_INITIAL_RETRIES,
      retryBaseDelayMs = DEFAULT_WEBVIEW_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs = DEFAULT_WEBVIEW_RETRY_MAX_DELAY_MS,
      showUnavailable = true,
      registry,
      partition,
    },
    handleRef
  ) => {
    const elementRef = useRef<HTMLElement | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const onReadyRef = useRef(onReady);
    const onConsoleRef = useRef(onConsoleMessage);
    const onNavigateRef = useRef(onNavigate);
    const onLoadingRef = useRef(onLoadingChange);
    const onTitleRef = useRef(onTitleChange);
    const onFaviconRef = useRef(onFaviconChange);
    const onFoundInPageRef = useRef(onFoundInPage);
    const onContextMenuRef = useRef(onContextMenu);
    const onErrorRef = useRef(onError);
    const srcRef = useRef(src);
    const registryRef = useRef(registry);
    const readyEmittedRef = useRef(false);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryAttemptRef = useRef(0);
    const maxInitialRetriesRef = useRef(maxInitialRetries);
    const retryBaseDelayMsRef = useRef(retryBaseDelayMs);
    const retryMaxDelayMsRef = useRef(retryMaxDelayMs);
    const registeredHandleRef = useRef<AppHandleId | null>(null);
    const [internalError, setInternalError] = useState<WebviewLoadError | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);
    // Resolved src for the <iframe> in browser/server mode. External http(s)
    // URLs are routed through `/proxy/<name>/…` so `frame-ancestors` /
    // `X-Frame-Options` don't block embedding. No-op in Electron `<webview>`.
    const [iframeSrc, setIframeSrc] = useState<string | undefined>(isElectron ? src : undefined);

    const emitError = useCallback((error: WebviewLoadError) => {
      if (onErrorRef.current) {
        onErrorRef.current(error);
      } else {
        setInternalError(error);
      }
    }, []);

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
      onFaviconRef.current = onFaviconChange;
    }, [onFaviconChange]);
    useEffect(() => {
      onFoundInPageRef.current = onFoundInPage;
    }, [onFoundInPage]);
    useEffect(() => {
      onContextMenuRef.current = onContextMenu;
    }, [onContextMenu]);
    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);
    useEffect(() => {
      srcRef.current = src;
      retryAttemptRef.current = 0;
      setInternalError(null);
    }, [src]);
    // Resolve external URLs through the server's /proxy reverse-proxy so the
    // iframe doesn't get killed by X-Frame-Options / frame-ancestors.
    useEffect(() => {
      if (isElectron) {
        setIframeSrc(src);
        return;
      }
      if (!src) {
        setIframeSrc(undefined);
        return;
      }
      let cancelled = false;
      void resolveProxiedSrc(src).then((resolved) => {
        if (!cancelled) {
          if (!resolved.ok) {
            setIframeSrc(undefined);
            emitError({ code: resolved.status ?? -1, description: resolved.reason, url: resolved.canonicalUrl });
            return;
          }
          setIframeSrc(resolved.iframeSrc);
          if (resolved.canonicalUrl !== src) {
            onNavigateRef.current?.(resolved.canonicalUrl);
            const currentRegistry = registryRef.current;
            if (currentRegistry) {
              updateApp(currentRegistry.handleId, { url: resolved.canonicalUrl });
            }
          }
        }
      });
      return () => {
        cancelled = true;
      };
    }, [emitError, src]);
    useEffect(() => {
      registryRef.current = registry;
    }, [registry]);
    useEffect(() => {
      maxInitialRetriesRef.current = maxInitialRetries;
    }, [maxInitialRetries]);
    useEffect(() => {
      retryBaseDelayMsRef.current = retryBaseDelayMs;
    }, [retryBaseDelayMs]);
    useEffect(() => {
      retryMaxDelayMsRef.current = retryMaxDelayMs;
    }, [retryMaxDelayMs]);
    useEffect(() => {
      const currentRegistry = registry;
      const currentSrc = src;
      if (!currentRegistry || !currentSrc || !elementRef.current) {
        return;
      }
      const webContentsId = (() => {
        if (!isElectron) {
          return undefined;
        }
        try {
          return (elementRef.current as unknown as Electron.WebviewTag).getWebContentsId?.();
        } catch {
          return undefined;
        }
      })();
      if (registeredHandleRef.current && registeredHandleRef.current !== currentRegistry.handleId) {
        unregisterApp(registeredHandleRef.current);
        registeredHandleRef.current = null;
      }
      if (registeredHandleRef.current === currentRegistry.handleId) {
        updateApp(currentRegistry.handleId, {
          url: currentSrc,
          ...(webContentsId !== undefined ? { webContentsId } : {}),
        });
        return;
      }
      registerApp({
        handleId: currentRegistry.handleId,
        appId: currentRegistry.appId,
        kind: currentRegistry.kind,
        scope: currentRegistry.scope,
        tabId: currentRegistry.tabId,
        label: currentRegistry.label,
        url: currentSrc,
        controllable: isControllableKind(currentRegistry.kind),
        ...(webContentsId !== undefined ? { webContentsId } : {}),
        ...(currentRegistry.browserTabsetId ? { browserTabsetId: currentRegistry.browserTabsetId } : {}),
      });
      registeredHandleRef.current = currentRegistry.handleId;
    }, [registry, src]);

    useImperativeHandle(
      handleRef,
      () => ({
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
            } catch {
              /* cross-origin */
            }
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
            } catch {
              /* cross-origin */
            }
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
            } catch {
              /* cross-origin */
            }
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
            const win = (el as HTMLIFrameElement).contentWindow as
              | (Window & { eval: (code: string) => unknown })
              | null;
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
        findInPage: (text, options) => {
          const el = elementRef.current;
          if (!el || !isElectron || !text) {
            return;
          }
          try {
            (el as unknown as Electron.WebviewTag).findInPage(text, options);
          } catch {
            // webview not ready — safe to ignore; caller will retry on next keystroke
          }
        },
        stopFindInPage: (action = 'clearSelection') => {
          const el = elementRef.current;
          if (!el || !isElectron) {
            return;
          }
          try {
            (el as unknown as Electron.WebviewTag).stopFindInPage(action);
          } catch {
            // ignore
          }
        },
        openDevTools: () => {
          const el = elementRef.current;
          if (!el || !isElectron) {
            return;
          }
          try {
            (el as unknown as Electron.WebviewTag).openDevTools();
          } catch {
            // ignore
          }
        },
      }),
      []
    );

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

      const attempt = retryAttemptRef.current++;
      const delay = getRetryDelayMs({
        attempt,
        baseDelayMs: retryBaseDelayMsRef.current,
        maxDelayMs: retryMaxDelayMsRef.current,
      });
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
        retryAttemptRef.current = 0;
        readyEmittedRef.current = false;

        const currentSrc = srcRef.current;
        if (!node || !currentSrc) {
          return;
        }

        elementRef.current = node;

        if (isElectron) {
          const el = node as unknown as Electron.WebviewTag;
          const currentRegistry = registryRef.current;

          // Register with the app-control registry as early as possible so
          // list_apps sees the handle even before first load. webContentsId
          // fills in on the first did-finish-load below.
          if (currentRegistry) {
            registerApp({
              handleId: currentRegistry.handleId,
              appId: currentRegistry.appId,
              kind: currentRegistry.kind,
              scope: currentRegistry.scope,
              tabId: currentRegistry.tabId,
              label: currentRegistry.label,
              url: currentSrc,
              controllable: isControllableKind(currentRegistry.kind),
              ...(currentRegistry.browserTabsetId ? { browserTabsetId: currentRegistry.browserTabsetId } : {}),
            });
            registeredHandleRef.current = currentRegistry.handleId;
          }

          const onStartLoad = () => {
            onLoadingRef.current?.(true);
          };

          const onLoad = () => {
            clearRetryTimer();
            retryAttemptRef.current = 0;
            onLoadingRef.current?.(false);

            if (!readyEmittedRef.current) {
              readyEmittedRef.current = true;
              onReadyRef.current?.();
            }

            const currentRegistry = registryRef.current;
            if (currentRegistry) {
              const webContentsId = (() => {
                try {
                  return el.getWebContentsId?.();
                } catch {
                  return undefined;
                }
              })();
              updateApp(currentRegistry.handleId, {
                webContentsId,
                url: (() => {
                  try {
                    return el.getURL?.();
                  } catch {
                    return undefined;
                  }
                })(),
              });
            }

            // Read page title
            if (el.getTitle?.()) {
              onTitleRef.current?.(el.getTitle());
            } else {
              void el
                .executeJavaScript?.('document.title')
                .then((t: string) => onTitleRef.current?.(t))
                .catch(() => {});
            }
          };

          const onFailLoad = (event: unknown) => {
            const e = event as {
              errorCode?: number;
              errorDescription?: string;
              validatedURL?: string;
              isMainFrame?: boolean;
            };
            const errorCode = e.errorCode ?? null;
            const isMainFrame = e.isMainFrame ?? true;

            if (!isMainFrame) {
              return;
            }
            if (isAbortErrorCode(errorCode)) {
              return;
            } // ERR_ABORTED
            onLoadingRef.current?.(false);

            if (readyEmittedRef.current) {
              emitError({
                code: errorCode ?? -1,
                description: e.errorDescription ?? 'Load failed',
                url: e.validatedURL ?? '',
              });
              return;
            }
            if (
              !shouldRetryInitialLoad({
                errorCode,
                ready: readyEmittedRef.current,
                attempt: retryAttemptRef.current,
                maxAttempts: maxInitialRetriesRef.current,
              })
            ) {
              emitError({
                code: errorCode ?? -1,
                description: e.errorDescription ?? 'Load failed',
                url: e.validatedURL ?? srcRef.current ?? '',
              });
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
              const currentRegistry = registryRef.current;
              if (currentRegistry) {
                updateApp(currentRegistry.handleId, { url: e.url });
              }
            }
          };

          const onTitleUpdate = (event: unknown) => {
            const e = event as { title?: string };
            if (e.title) {
              onTitleRef.current?.(e.title);
              const currentRegistry = registryRef.current;
              if (currentRegistry) {
                updateApp(currentRegistry.handleId, { title: e.title });
              }
            }
          };

          const onFavicon = (event: unknown) => {
            const e = event as { favicons?: string[] };
            const favicon = e.favicons?.[0];
            if (favicon) {
              onFaviconRef.current?.(favicon);
            }
          };

          const onFoundInPage = (event: unknown) => {
            const e = event as { result?: FoundInPageResult };
            if (e.result) {
              onFoundInPageRef.current?.(e.result);
            }
          };

          const onContextMenuEvent = (event: unknown) => {
            const e = event as { params?: ContextMenuParams };
            if (e.params) {
              onContextMenuRef.current?.(e.params);
            }
          };

          el.addEventListener('did-start-loading', onStartLoad);
          el.addEventListener('did-finish-load', onLoad);
          el.addEventListener('did-fail-load', onFailLoad);
          el.addEventListener('console-message', onConsole);
          el.addEventListener('did-navigate', onNavigateEvent);
          el.addEventListener('did-navigate-in-page', onNavigateEvent);
          el.addEventListener('page-title-updated', onTitleUpdate);
          el.addEventListener('page-favicon-updated', onFavicon);
          el.addEventListener('found-in-page', onFoundInPage);
          el.addEventListener('context-menu', onContextMenuEvent);

          cleanupRef.current = () => {
            el.removeEventListener('did-start-loading', onStartLoad);
            el.removeEventListener('did-finish-load', onLoad);
            el.removeEventListener('did-fail-load', onFailLoad);
            el.removeEventListener('console-message', onConsole);
            el.removeEventListener('did-navigate', onNavigateEvent);
            el.removeEventListener('did-navigate-in-page', onNavigateEvent);
            el.removeEventListener('page-title-updated', onTitleUpdate);
            el.removeEventListener('page-favicon-updated', onFavicon);
            el.removeEventListener('found-in-page', onFoundInPage);
            el.removeEventListener('context-menu', onContextMenuEvent);
            if (registeredHandleRef.current) {
              unregisterApp(registeredHandleRef.current);
              registeredHandleRef.current = null;
            }
          };
        } else {
          // Browser mode: use iframe events
          const iframe = node as HTMLIFrameElement;

          onLoadingRef.current?.(true);

          const onLoad = () => {
            clearRetryTimer();
            retryAttemptRef.current = 0;
            onLoadingRef.current?.(false);

            if (!readyEmittedRef.current) {
              readyEmittedRef.current = true;
              onReadyRef.current?.();
            }

            // Report the navigated URL and title back
            try {
              const href = iframe.contentWindow?.location.href;
              if (href && href !== 'about:blank') {
                const canonicalUrl = unproxyUrl(href);
                onNavigateRef.current?.(canonicalUrl);
                const currentRegistry = registryRef.current;
                if (currentRegistry) {
                  updateApp(currentRegistry.handleId, { url: canonicalUrl });
                }
              }
              const title = iframe.contentDocument?.title;
              if (title) {
                onTitleRef.current?.(title);
              }
            } catch {
              /* cross-origin */
            }
          };

          const onIframeError = () => {
            onLoadingRef.current?.(false);
            const transportUrl = iframe.src;
            const unproxiedUrl = unproxyUrl(transportUrl);
            const errorUrl =
              unproxiedUrl && unproxiedUrl !== transportUrl ? unproxiedUrl : srcRef.current || unproxiedUrl || '';
            const error = {
              code: -1,
              description: 'Failed to load page',
              url: errorUrl,
              ...(transportUrl && transportUrl !== errorUrl ? { transportUrl } : {}),
            };
            if (readyEmittedRef.current) {
              emitError(error);
              return;
            }
            if (
              !shouldRetryInitialLoad({
                errorCode: -1,
                ready: readyEmittedRef.current,
                attempt: retryAttemptRef.current,
                maxAttempts: maxInitialRetriesRef.current,
              })
            ) {
              emitError(error);
              return;
            }
            scheduleRetry();
          };

          const onMessage = (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow) {
              return;
            }
            const data = event.data as {
              type?: string;
              level?: string;
              message?: string;
              url?: string;
              title?: string;
            } | null;
            if (data?.type === '__preview_console__') {
              const level = data.level === 'error' ? 'error' : data.level === 'warn' ? 'warn' : 'log';
              onConsoleRef.current?.({ level, message: data.message ?? '' });
            } else if (data?.type === '__preview_navigate__' && data.url) {
              const canonicalUrl = unproxyUrl(data.url);
              onNavigateRef.current?.(canonicalUrl);
              const currentRegistry = registryRef.current;
              if (currentRegistry) {
                updateApp(currentRegistry.handleId, { url: canonicalUrl });
              }
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
      [clearRetryTimer, emitError, scheduleRetry]
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

    if (internalError) {
      const diagnostics = getWebviewFallbackDiagnostics(internalError, src);
      return (
        <div
          style={{
            display: 'flex',
            height: '100%',
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{ display: 'flex', maxWidth: 580, flexDirection: 'column', gap: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{diagnostics.title}</div>
            <div style={{ opacity: 0.78 }}>{diagnostics.reason}</div>
            <div>
              <div style={{ marginBottom: 4, fontSize: 12, fontWeight: 600, opacity: 0.7 }}>Canonical URL</div>
              <div style={{ wordBreak: 'break-all', opacity: 0.7, fontSize: 12 }}>{diagnostics.displayUrl}</div>
            </div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>{diagnostics.instructions}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  retryAttemptRef.current = 0;
                  setInternalError(null);
                  setReloadNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(diagnostics.canonicalUrl).catch(() => {})}
              >
                Copy URL
              </button>
              <button type="button" onClick={() => openInBrowserTab(diagnostics.canonicalUrl)}>
                Open in Browser
              </button>
            </div>
            {(diagnostics.transportUrl || diagnostics.debugDescription) && (
              <details style={{ marginTop: 4, textAlign: 'left', fontSize: 11, opacity: 0.65 }}>
                <summary style={{ cursor: 'pointer', textAlign: 'center' }}>Details</summary>
                {diagnostics.debugDescription && <div>Reason: {diagnostics.debugDescription}</div>}
                {diagnostics.transportUrl && (
                  <div style={{ wordBreak: 'break-all' }}>Proxy transport: {diagnostics.transportUrl}</div>
                )}
              </details>
            )}
          </div>
        </div>
      );
    }

    if (isElectron) {
      // `partition` must be set BEFORE the <webview> is inserted into the DOM;
      // Electron ignores later changes. Keying on partition forces a remount so
      // switching profiles actually takes effect.
      return (
        <webview
          key={`${partition ?? 'default'}:${reloadNonce}`}
          ref={callbackRef}
          src={src}
          {...{ useragent: embeddedUserAgent }}
          {...(partition ? { partition } : {})}
          style={{ width: '100%', height: '100%' }}
        />
      );
    }

    return (
      <iframe
        key={reloadNonce}
        ref={callbackRef as React.RefCallback<HTMLIFrameElement>}
        src={iframeSrc}
        style={{ width: '100%', height: '100%', border: 'none' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    );
  }
);
Webview.displayName = 'Webview';
