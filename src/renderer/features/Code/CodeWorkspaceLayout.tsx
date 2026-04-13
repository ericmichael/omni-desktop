import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft20Regular, ArrowRight20Regular, ArrowClockwise20Regular, Code20Regular, Desktop20Regular, Dismiss20Regular, DismissCircle20Regular, Globe20Regular, WindowConsole20Regular, WindowDevTools20Regular } from '@fluentui/react-icons';

import { resolvePreviewUrl, reverseProxyUrl } from '@/renderer/features/Tickets/preview-bridge';

import { Webview } from '@/renderer/common/Webview';
import type { WebviewHandle, ConsoleMessage } from '@/renderer/common/Webview';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $terminals, createTerminal } from '@/renderer/features/Console/state';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { WebPreview, WebPreviewConsole, WebPreviewUrl, useWebPreviewContext } from '@/renderer/omniagents-ui/components/ai/web-preview';
import { persistedStoreApi } from '@/renderer/services/store';

import type { DockPane } from './EnvironmentDock';
import { EnvironmentDock } from './EnvironmentDock';

type OverlayPane = DockPane;

type CodeWorkspaceLayoutProps = {
  uiSrc: string;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  codeServerSrc?: string;
  vncSrc?: string;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  overlayPane?: OverlayPane;
  onCloseOverlay?: () => void;
  onOpenOverlay?: (pane: Exclude<OverlayPane, 'none'>) => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  sandboxLabel?: string;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  dockTargetId?: string;
  isGlass?: boolean;
};

const useStyles = makeStyles({
  backdrop: { position: 'absolute', inset: 0, zIndex: 30, backgroundColor: 'rgba(0, 0, 0, 0.45)' },
  overlayCard: {
    position: 'absolute',
    inset: '4px',
    zIndex: 40,
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
    '@media (min-width: 640px)': { inset: '12px' },
  },
  overlayInner: { display: 'flex', height: '100%', flexDirection: 'column' },
  overlayHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  overlayHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    flex: '1 1 0',
    minWidth: 0,
  },
  overlayCloseBtn: {
    display: 'inline-flex',
    width: '36px',
    height: '36px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  overlayNavBtn: {
    display: 'inline-flex',
    width: '28px',
    height: '28px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  overlayNavBtnDisabled: {
    opacity: 0.3,
    cursor: 'default',
    ':hover': { backgroundColor: 'transparent', color: tokens.colorNeutralForeground3 },
  },
  loadingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '2px',
    backgroundColor: tokens.colorBrandBackground,
    zIndex: 1,
    animationName: {
      '0%': { width: '0%' },
      '50%': { width: '70%' },
      '100%': { width: '95%' },
    },
    animationDuration: '8s',
    animationTimingFunction: 'ease-out',
    animationFillMode: 'forwards',
  },
  overlayBody: { minHeight: 0, flex: '1 1 0' },
  root: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  mainArea: { position: 'relative', minHeight: 0, flex: '1 1 0' },
  mainContent: { height: '100%', width: '100%', minWidth: 0 },
  glassChatSurfaces: {
    '& .bg-surface, & .bg-card, & .bg-background, & .bg-bgColumn, & .bg-bgCard, & .bg-bgCardAlt, & .bg-bgMain': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
      backdropFilter: 'blur(28px) saturate(160%)',
      WebkitBackdropFilter: 'blur(28px) saturate(160%)',
    },
    '& .bg-secondary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.12) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
    '& .bg-primary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 70%, transparent)`,
      backdropFilter: 'blur(20px) saturate(160%)',
      WebkitBackdropFilter: 'blur(20px) saturate(160%)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.14) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
    '& .chat-input-footer': {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      borderTop: `1px solid rgba(255, 255, 255, 0.14)`,
    },
    '& .chat-input-footer::before': {
      content: '""',
      position: 'absolute',
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
      borderRadius: '24px',
      boxShadow: '0 0 0 9999px rgba(255, 255, 255, 0.06)',
      pointerEvents: 'none',
      zIndex: 0,
    },
    '& .chat-input-footer > *': {
      position: 'relative',
      zIndex: 1,
    },
    '& .chat-input-footer .bg-bgCardAlt': {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    },
  },
});

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

type ConsoleLog = { level: 'log' | 'warn' | 'error' | 'result'; message: string; timestamp: Date };
const MAX_CONSOLE_LOGS = 500;

export type PreviewState = {
  loading: boolean;
  title: string;
  error: { code: number; description: string; url: string } | null;
};

/** Reads the URL from WebPreview context, resolves it through the proxy in browser mode, and renders via the platform-aware Webview. */
const PreviewWebview = memo(({ webviewRef: externalRef, onStateChange }: { webviewRef?: React.Ref<WebviewHandle>; onStateChange?: (state: PreviewState) => void }) => {
  const { url, setUrl } = useWebPreviewContext();
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
  const [webviewKey, setWebviewKey] = useState(0);
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [previewState, setPreviewState] = useState<PreviewState>({ loading: false, title: '', error: null });
  const internalRef = useRef<WebviewHandle>(null);
  const navigatedUrlRef = useRef<string | null>(null);
  const onStateRef = useRef(onStateChange);
  useEffect(() => { onStateRef.current = onStateChange; }, [onStateChange]);

  // Forward the internal ref to external ref if provided
  useEffect(() => {
    if (!externalRef) return;
    if (typeof externalRef === 'function') {
      externalRef(internalRef.current);
    } else {
      (externalRef as React.MutableRefObject<WebviewHandle | null>).current = internalRef.current;
    }
  });

  const updateState = useCallback((patch: Partial<PreviewState>) => {
    setPreviewState((prev) => {
      const next = { ...prev, ...patch };
      onStateRef.current?.(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!url) {
      setResolvedUrl(undefined);
      return;
    }
    // If this URL came from in-frame navigation, the iframe is already showing the
    // right content — only the URL bar needed updating, don't touch resolvedUrl.
    if (navigatedUrlRef.current === url) {
      navigatedUrlRef.current = null;
      return;
    }
    let cancelled = false;
    void resolvePreviewUrl(url).then((resolved) => {
      if (!cancelled) {
        setResolvedUrl(resolved);
        // Bump key to force iframe remount when upstream changes but proxy path is identical
        setWebviewKey((k) => k + 1);
      }
    });
    return () => { cancelled = true; };
  }, [url]);

  // Clear logs when the user explicitly navigates (not in-frame clicks)
  const prevUrlRef = useRef(url);
  useEffect(() => {
    if (url !== prevUrlRef.current) {
      // Only clear if this wasn't an in-frame navigation
      if (navigatedUrlRef.current !== url) {
        setLogs([]);
      }
      prevUrlRef.current = url;
    }
  }, [url]);

  const handleNavigate = useCallback((navigatedUrl: string) => {
    // Reverse-map proxy URLs back to the original upstream URL for display
    const displayUrl = reverseProxyUrl(navigatedUrl);
    // Update the URL bar without triggering a re-resolve
    navigatedUrlRef.current = displayUrl;
    setUrl(displayUrl);
  }, [setUrl]);

  const appendLog = useCallback((entry: ConsoleLog) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_CONSOLE_LOGS ? next.slice(-MAX_CONSOLE_LOGS) : next;
    });
  }, []);

  const handleConsoleMessage = useCallback((msg: ConsoleMessage) => {
    appendLog({ ...msg, timestamp: new Date() });
  }, [appendLog]);

  const handleLoadingChange = useCallback((loading: boolean) => {
    updateState({ loading, ...(loading ? { error: null } : {}) });
  }, [updateState]);

  const handleTitleChange = useCallback((title: string) => {
    updateState({ title });
  }, [updateState]);

  const handleError = useCallback((error: { code: number; description: string; url: string }) => {
    updateState({ error });
  }, [updateState]);

  const handleClear = useCallback(() => {
    setLogs([]);
  }, []);

  const handleExecute = useCallback((code: string) => {
    // Log the input
    appendLog({ level: 'log', message: `> ${code}`, timestamp: new Date() });
    // Execute in the webview/iframe
    const handle = internalRef.current;
    if (!handle) return;
    void handle.executeScript(code).then(
      (result) => {
        const display = result === undefined ? 'undefined' : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        appendLog({ level: 'result', message: String(display), timestamp: new Date() });
      },
      (err) => {
        appendLog({ level: 'error', message: String(err), timestamp: new Date() });
      }
    );
  }, [appendLog]);

  return (
    <>
      <div style={{ flex: '1 1 0', minHeight: 0 }}>
        {resolvedUrl ? (
          <Webview key={webviewKey} ref={internalRef} src={resolvedUrl} showUnavailable={false} onConsoleMessage={handleConsoleMessage} onNavigate={handleNavigate} onLoadingChange={handleLoadingChange} onTitleChange={handleTitleChange} onError={handleError} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: tokens.colorNeutralForeground4 }}>
            <Globe20Regular style={{ width: 40, height: 40, opacity: 0.4 }} />
            <span style={{ fontSize: tokens.fontSizeBase300 }}>Enter a URL to get started</span>
            <span style={{ fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground4 }}>Preview web apps, inspect console output, and debug</span>
          </div>
        )}
      </div>
      <WebPreviewConsole logs={logs} onClear={handleClear} onExecute={handleExecute} />
    </>
  );
});
PreviewWebview.displayName = 'PreviewWebview';

/** Toolbar button that toggles the console panel via WebPreview context. */
const ConsoleToggleButton = memo(({ className }: { className?: string }) => {
  const { consoleOpen, setConsoleOpen } = useWebPreviewContext();
  return (
    <button
      type="button"
      onClick={() => setConsoleOpen(!consoleOpen)}
      className={className}
      aria-label={consoleOpen ? 'Hide console' : 'Show console'}
      title={consoleOpen ? 'Hide console' : 'Show console'}
    >
      <WindowDevTools20Regular style={{ width: 14, height: 14, opacity: consoleOpen ? 1 : 0.6 }} />
    </button>
  );
});
ConsoleToggleButton.displayName = 'ConsoleToggleButton';

const PANE_META: Record<Exclude<OverlayPane, 'none'>, { title: string; Icon: typeof Code20Regular }> = {
  code: { title: 'VS Code', Icon: Code20Regular },
  vnc: { title: "Omni's PC", Icon: Desktop20Regular },
  preview: { title: 'Preview', Icon: Globe20Regular },
  terminal: { title: 'Terminal', Icon: WindowConsole20Regular },
};

const OverlayPaneView = memo(
  ({ pane, src, onClose, onUrlChange }: { pane: Exclude<OverlayPane, 'none'>; src?: string; onClose: () => void; onUrlChange?: (url: string) => void }) => {
    const styles = useStyles();
    const { title, Icon } = PANE_META[pane];
    const webviewRef = useRef<WebviewHandle>(null);
    const [pState, setPState] = useState<PreviewState>({ loading: false, title: '', error: null });
    const urlBarRef = useRef<HTMLInputElement>(null);

    // Keyboard shortcuts for the preview overlay
    useEffect(() => {
      if (pane !== 'preview') return;
      const handler = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'r') {
          e.preventDefault();
          webviewRef.current?.reload();
        } else if (mod && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          urlBarRef.current?.focus();
          urlBarRef.current?.select();
        } else if (e.key === 'Escape') {
          if (pState.loading) {
            webviewRef.current?.stop();
          }
        } else if (mod && e.key === '[') {
          e.preventDefault();
          webviewRef.current?.goBack();
        } else if (mod && e.key === ']') {
          e.preventDefault();
          webviewRef.current?.goForward();
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [pane, pState.loading]);

    return (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className={styles.backdrop}
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={transition}
          className={styles.overlayCard}
        >
          {pane === 'terminal' ? (
            <ConsoleStarted />
          ) : pane === 'preview' ? (
            <WebPreview defaultUrl={src ?? ''} onUrlChange={onUrlChange} className="size-full rounded-none border-0">
              <div className={styles.overlayHeader} style={{ position: 'relative' }}>
                {pState.loading && <div className={styles.loadingBar} />}
                <div className={styles.overlayHeaderLeft}>
                  <button type="button" onClick={() => webviewRef.current?.goBack()} className={styles.overlayNavBtn} aria-label="Go back" title="Back (Ctrl+[)">
                    <ArrowLeft20Regular style={{ width: 14, height: 14 }} />
                  </button>
                  <button type="button" onClick={() => webviewRef.current?.goForward()} className={styles.overlayNavBtn} aria-label="Go forward" title="Forward (Ctrl+])">
                    <ArrowRight20Regular style={{ width: 14, height: 14 }} />
                  </button>
                  {pState.loading ? (
                    <button type="button" onClick={() => webviewRef.current?.stop()} className={styles.overlayNavBtn} aria-label="Stop" title="Stop (Esc)">
                      <DismissCircle20Regular style={{ width: 14, height: 14 }} />
                    </button>
                  ) : (
                    <button type="button" onClick={() => webviewRef.current?.reload()} className={styles.overlayNavBtn} aria-label="Reload" title="Reload (Ctrl+R)">
                      <ArrowClockwise20Regular style={{ width: 14, height: 14 }} />
                    </button>
                  )}
                  <WebPreviewUrl ref={urlBarRef} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  <ConsoleToggleButton className={styles.overlayNavBtn} />
                  <button
                    type="button"
                    onClick={onClose}
                    className={styles.overlayCloseBtn}
                    aria-label="Close overlay"
                  >
                    <Dismiss20Regular style={{ width: 14, height: 14 }} />
                  </button>
                </div>
              </div>
              <PreviewWebview webviewRef={webviewRef} onStateChange={setPState} />
            </WebPreview>
          ) : (
            <div className={styles.overlayInner}>
              <div className={styles.overlayHeader}>
                <div className={styles.overlayHeaderLeft}>
                  <Icon style={{ width: 14, height: 14 }} />
                  <span>{title}</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className={styles.overlayCloseBtn}
                  aria-label="Close overlay"
                >
                  <Dismiss20Regular style={{ width: 14, height: 14 }} />
                </button>
              </div>
              <div className={styles.overlayBody}>
                <Webview src={src ?? ''} showUnavailable={false} />
              </div>
            </div>
          )}
        </motion.div>
      </>
    );
  }
);
OverlayPaneView.displayName = 'OverlayPaneView';

export const CodeWorkspaceLayout = memo(({ uiSrc, sessionId, onSessionChange, variables, codeServerSrc, vncSrc, previewUrl, onPreviewUrlChange, overlayPane = 'none', onCloseOverlay, onOpenOverlay, onReady, headerActionsTargetId, headerActionsCompact, sandboxLabel, onClientToolCall, pendingPlan, onPlanDecision, dockTargetId, isGlass }: CodeWorkspaceLayoutProps) => {
  const styles = useStyles();
  const overlaySrc = overlayPane === 'code' ? codeServerSrc : overlayPane === 'vnc' ? vncSrc : overlayPane === 'preview' ? previewUrl : undefined;

  const [dockTarget, setDockTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!dockTargetId) {
      setDockTarget(null);
      return;
    }
    setDockTarget(document.getElementById(dockTargetId));
  }, [dockTargetId]);

  const handleUiReady = useCallback(() => {
    onReady?.();
  }, [onReady]);

  const closeOverlay = useCallback(() => {
    onCloseOverlay?.();
  }, [onCloseOverlay]);

  const handleDockSelect = useCallback(
    (pane: DockPane) => {
      if (pane === 'none') {
        onCloseOverlay?.();
      } else if (pane === 'terminal') {
        // Auto-create a terminal if none exist when opening the pane
        if ($terminals.get().length === 0) {
          const cwd = persistedStoreApi.$atom.get().workspaceDir ?? undefined;
          createTerminal(cwd);
        }
        onOpenOverlay?.(pane);
      } else {
        onOpenOverlay?.(pane);
      }
    },
    [onCloseOverlay, onOpenOverlay]
  );

  const showOverlay = overlayPane !== 'none' && (overlaySrc || overlayPane === 'preview' || overlayPane === 'terminal');

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass, isGlass && styles.glassChatSurfaces)}>
      <div className={styles.mainArea}>
        <div className={styles.mainContent}>
          <OmniAgentsApp uiUrl={uiSrc} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} onReady={handleUiReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} sandboxLabel={sandboxLabel} onClientToolCall={onClientToolCall} pendingPlan={pendingPlan} onPlanDecision={onPlanDecision} />
        </div>
        <AnimatePresence>
          {showOverlay && <OverlayPaneView pane={overlayPane as Exclude<OverlayPane, 'none'>} src={overlaySrc} onClose={closeOverlay} onUrlChange={overlayPane === 'preview' ? onPreviewUrlChange : undefined} />}
        </AnimatePresence>
      </div>
      {(() => {
        const dock = (
          <EnvironmentDock
            activePane={overlayPane}
            onSelect={handleDockSelect}
            codeAvailable={!!codeServerSrc}
            desktopAvailable={!!vncSrc}
            isGlass={isGlass}
          />
        );
        if (dockTargetId && dockTarget) {
          return createPortal(dock, dockTarget);
        }
        return dock;
      })()}
    </div>
  );
});
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
