import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { ArrowClockwise20Regular, ArrowLeft20Regular, ArrowRight20Regular, DismissCircle20Regular, Globe20Regular, WindowDevTools20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ConsoleMessage, WebviewHandle, WebviewRegistryProps } from '@/renderer/common/Webview';
import { Webview } from '@/renderer/common/Webview';
import { ConsoleStarted } from '@/renderer/features/Console/ConsoleRunning';
import { $terminals, createTerminal } from '@/renderer/features/Console/state';
import { resolvePreviewUrl, reverseProxyUrl } from '@/renderer/features/Tickets/preview-bridge';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { useWebPreviewContext, WebPreview, WebPreviewConsole, WebPreviewUrl } from '@/renderer/omniagents-ui/components/ai/web-preview';
import { persistedStoreApi } from '@/renderer/services/store';
import { makeAppHandleId } from '@/shared/app-control-types';
import type { AppDescriptor, AppId } from '@/shared/app-registry';
import { buildAppRegistry } from '@/shared/app-registry';

import { AppIcon } from './AppIcon';
import { EnvironmentDock } from './EnvironmentDock';

type CodeWorkspaceLayoutProps = {
  uiSrc: string;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  codeServerSrc?: string;
  vncSrc?: string;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  activeApp?: AppId;
  onActiveAppChange?: (app: AppId) => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  sandboxLabel?: string;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  dockTargetId?: string;
  isGlass?: boolean;
  /**
   * When provided, this layout hosts a column-scoped workspace and all its
   * webviews register under `tab-<tabId>:*`. Omit for the global dock.
   */
  tabId?: string;
};

/** Build a `WebviewRegistryProps` entry from an AppDescriptor + layout scope. */
function makeRegistryProps(app: AppDescriptor, tabId: string | undefined): WebviewRegistryProps {
  const scope = tabId ? 'column' : 'global';
  return {
    handleId: makeAppHandleId(scope, app.id, tabId),
    appId: app.id,
    kind: app.kind,
    scope,
    tabId,
    label: app.label,
  };
}

const useStyles = makeStyles({
  surfaceCard: {
    position: 'absolute',
    inset: 0,
    zIndex: 40,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 1px 0 rgba(255,255,255,0.04) inset`,
  },
  surfaceCardGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 18%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    boxShadow: `0 1px 0 rgba(255,255,255,0.10) inset, 0 -1px 0 rgba(255,255,255,0.04) inset`,
  },
  surfaceInner: { display: 'flex', height: '100%', flexDirection: 'column', backgroundColor: 'inherit' },
  surfaceHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    minHeight: '44px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    gap: tokens.spacingHorizontalM,
  },
  surfaceHeaderGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 14%, transparent)`,
    backdropFilter: 'blur(24px) saturate(160%)',
    WebkitBackdropFilter: 'blur(24px) saturate(160%)',
    borderBottomColor: 'rgba(255, 255, 255, 0.14)',
  },
  surfaceHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    flex: '1 1 0',
    minWidth: 0,
  },
  surfaceHeaderTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  surfaceTitleText: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightMedium,
    letterSpacing: '-0.01em',
  },
  surfaceHeaderToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flex: '1 1 0',
    minWidth: 0,
  },
  surfaceHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  surfaceNavBtn: {
    display: 'inline-flex',
    width: '30px',
    height: '30px',
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
  surfaceBody: { minHeight: 0, flex: '1 1 0', position: 'relative', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground1 },
  surfaceBodyGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 10%, transparent)`,
  },
  surfaceContentFill: { flex: '1 1 0', minHeight: 0, minWidth: 0 },
  browserUrlWrap: { minWidth: '240px', flex: '1 1 360px' },
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
  mainContentHidden: { display: 'none' },
  unavailableState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase300,
  },
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

type PreviewState = {
  loading: boolean;
  title: string;
  error: { code: number; description: string; url: string } | null;
};

const PreviewWebview = memo(({ webviewRef: externalRef, onStateChange, registry }: { webviewRef?: React.Ref<WebviewHandle>; onStateChange?: (state: PreviewState) => void; registry?: WebviewRegistryProps }) => {
  const { url, setUrl } = useWebPreviewContext();
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
  const [webviewKey, setWebviewKey] = useState(0);
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [, setPreviewState] = useState<PreviewState>({ loading: false, title: '', error: null });
  const internalRef = useRef<WebviewHandle>(null);
  const navigatedUrlRef = useRef<string | null>(null);
  const onStateRef = useRef(onStateChange);
  useEffect(() => {
 onStateRef.current = onStateChange; 
}, [onStateChange]);

  useEffect(() => {
    if (!externalRef) {
return;
}
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
    if (navigatedUrlRef.current === url) {
      navigatedUrlRef.current = null;
      return;
    }
    let cancelled = false;
    void resolvePreviewUrl(url).then((resolved) => {
      if (!cancelled) {
        setResolvedUrl(resolved);
        setWebviewKey((current) => current + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const prevUrlRef = useRef(url);
  useEffect(() => {
    if (url !== prevUrlRef.current) {
      if (navigatedUrlRef.current !== url) {
        setLogs([]);
      }
      prevUrlRef.current = url;
    }
  }, [url]);

  const handleNavigate = useCallback((navigatedUrl: string) => {
    const displayUrl = reverseProxyUrl(navigatedUrl);
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
    appendLog({ level: 'log', message: `> ${code}`, timestamp: new Date() });
    const handle = internalRef.current;
    if (!handle) {
return;
}
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
          <Webview key={webviewKey} ref={internalRef} src={resolvedUrl} showUnavailable={false} onConsoleMessage={handleConsoleMessage} onNavigate={handleNavigate} onLoadingChange={handleLoadingChange} onTitleChange={handleTitleChange} onError={handleError} registry={registry} />
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

const BUILTIN_TITLES: Record<string, string> = {
  code: 'VS Code',
  desktop: "Omni's PC",
  browser: 'Browser',
  terminal: 'Terminal',
};

const SurfaceFrame = memo(({ app, isGlass, children }: { app: AppDescriptor; isGlass?: boolean; children: React.ReactNode }) => {
  const styles = useStyles();
  const title = BUILTIN_TITLES[app.id] ?? app.label;

  return (
    <div className={mergeClasses(styles.surfaceInner)}>
      <div className={mergeClasses(styles.surfaceHeader, isGlass && styles.surfaceHeaderGlass)}>
        <div className={styles.surfaceHeaderTitle}>
          <AppIcon icon={app.icon} size={14} />
          <span className={styles.surfaceTitleText}>{title}</span>
        </div>
        <div className={styles.surfaceHeaderActions} />
      </div>
      <div className={mergeClasses(styles.surfaceBody, isGlass && styles.surfaceBodyGlass)}>
        <div className={styles.surfaceContentFill}>{children}</div>
      </div>
    </div>
  );
});
SurfaceFrame.displayName = 'SurfaceFrame';

const BrowserSurface = memo(({ src, onUrlChange, isGlass, registry }: { src?: string; onUrlChange?: (url: string) => void; isGlass?: boolean; registry?: WebviewRegistryProps }) => {
  const styles = useStyles();
  const webviewRef = useRef<WebviewHandle>(null);
  const [previewState, setPreviewState] = useState<PreviewState>({ loading: false, title: '', error: null });
  const urlBarRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        webviewRef.current?.reload();
      } else if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        urlBarRef.current?.focus();
        urlBarRef.current?.select();
      } else if (event.key === 'Escape') {
        if (previewState.loading) {
          webviewRef.current?.stop();
        }
      } else if (mod && event.key === '[') {
        event.preventDefault();
        webviewRef.current?.goBack();
      } else if (mod && event.key === ']') {
        event.preventDefault();
        webviewRef.current?.goForward();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [previewState.loading]);

  return (
    <WebPreview defaultUrl={src ?? ''} onUrlChange={onUrlChange} className="size-full rounded-none border-0">
      <div className={mergeClasses(styles.surfaceHeader, isGlass && styles.surfaceHeaderGlass)} style={{ position: 'relative' }}>
        {previewState.loading && <div className={styles.loadingBar} />}
        <div className={styles.surfaceHeaderLeft}>
          <div className={styles.surfaceHeaderTitle}>
            <Globe20Regular style={{ width: 14, height: 14 }} />
            <span className={styles.surfaceTitleText}>Browser</span>
          </div>
          <div className={styles.surfaceHeaderToolbar}>
            <button type="button" onClick={() => webviewRef.current?.goBack()} className={styles.surfaceNavBtn} aria-label="Go back" title="Back (Ctrl+[)">
              <ArrowLeft20Regular style={{ width: 14, height: 14 }} />
            </button>
            <button type="button" onClick={() => webviewRef.current?.goForward()} className={styles.surfaceNavBtn} aria-label="Go forward" title="Forward (Ctrl+])">
              <ArrowRight20Regular style={{ width: 14, height: 14 }} />
            </button>
            {previewState.loading ? (
              <button type="button" onClick={() => webviewRef.current?.stop()} className={styles.surfaceNavBtn} aria-label="Stop" title="Stop (Esc)">
                <DismissCircle20Regular style={{ width: 14, height: 14 }} />
              </button>
            ) : (
              <button type="button" onClick={() => webviewRef.current?.reload()} className={styles.surfaceNavBtn} aria-label="Reload" title="Reload (Ctrl+R)">
                <ArrowClockwise20Regular style={{ width: 14, height: 14 }} />
              </button>
            )}
            <div className={styles.browserUrlWrap}>
              <WebPreviewUrl ref={urlBarRef} />
            </div>
          </div>
        </div>
        <div className={styles.surfaceHeaderActions}>
          <ConsoleToggleButton className={styles.surfaceNavBtn} />
        </div>
      </div>
      <div className={mergeClasses(styles.surfaceBody, isGlass && styles.surfaceBodyGlass)}>
        <PreviewWebview webviewRef={webviewRef} onStateChange={setPreviewState} registry={registry} />
      </div>
    </WebPreview>
  );
});
BrowserSurface.displayName = 'BrowserSurface';

const AppSurfaceView = memo(({ app, src, onUrlChange, isGlass, tabId }: { app: AppDescriptor; src?: string; onUrlChange?: (url: string) => void; isGlass?: boolean; tabId?: string }) => {
  const styles = useStyles();
  const registryProps = useMemo(() => makeRegistryProps(app, tabId), [app, tabId]);

  if (app.kind === 'builtin-browser') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <BrowserSurface src={src} onUrlChange={onUrlChange} isGlass={isGlass} registry={registryProps} />
      </motion.div>
    );
  }

  if (app.kind === 'builtin-terminal') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <SurfaceFrame app={app} isGlass={isGlass}>
          <ConsoleStarted />
        </SurfaceFrame>
      </motion.div>
    );
  }

  if (app.kind === 'webview') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
        <SurfaceFrame app={app} isGlass={isGlass}>
          {app.url ? <Webview src={app.url} showUnavailable={false} registry={registryProps} /> : <div className={styles.unavailableState}>No URL configured.</div>}
        </SurfaceFrame>
      </motion.div>
    );
  }

  // builtin-code, builtin-desktop
  return (
    <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={transition} className={mergeClasses(styles.surfaceCard, isGlass && styles.surfaceCardGlass)}>
      <SurfaceFrame app={app} isGlass={isGlass}>
        {src ? <Webview src={src} showUnavailable={false} registry={registryProps} /> : <div className={styles.unavailableState}>{app.label} is unavailable for this workspace.</div>}
      </SurfaceFrame>
    </motion.div>
  );
});
AppSurfaceView.displayName = 'AppSurfaceView';

export const CodeWorkspaceLayout = memo(({ uiSrc, sessionId, onSessionChange, variables, codeServerSrc, vncSrc, previewUrl, onPreviewUrlChange, activeApp = 'chat', onActiveAppChange, onReady, headerActionsTargetId, headerActionsCompact, sandboxLabel, onClientToolCall, pendingPlan, onPlanDecision, dockTargetId, isGlass, tabId }: CodeWorkspaceLayoutProps) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const registry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);
  // The dock only surfaces apps marked column-scoped. Global-only custom
  // apps are opened via the app launcher as their own deck column instead.
  const dockApps = useMemo(() => registry.filter((a) => a.columnScoped), [registry]);
  const activeDescriptor = useMemo(() => registry.find((a) => a.id === activeApp) ?? null, [registry, activeApp]);

  const sandboxUrls = useMemo(
    () => ({ codeServerUrl: codeServerSrc, noVncUrl: vncSrc }),
    [codeServerSrc, vncSrc]
  );

  const surfaceSrc = activeDescriptor
    ? activeDescriptor.kind === 'builtin-code'
      ? codeServerSrc
      : activeDescriptor.kind === 'builtin-desktop'
        ? vncSrc
        : activeDescriptor.kind === 'builtin-browser'
          ? previewUrl
          : undefined
    : undefined;

  useEffect(() => {
    if ((activeApp === 'code' && !codeServerSrc) || (activeApp === 'desktop' && !vncSrc)) {
      onActiveAppChange?.('chat');
    }
  }, [activeApp, codeServerSrc, vncSrc, onActiveAppChange]);

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

  const handleDockSelect = useCallback(
    (id: AppId) => {
      if (id === 'terminal' && $terminals.get().length === 0) {
        const cwd = persistedStoreApi.$atom.get().workspaceDir ?? undefined;
        createTerminal(cwd);
      }
      onActiveAppChange?.(id);
    },
    [onActiveAppChange]
  );

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass, isGlass && styles.glassChatSurfaces)}>
      <div className={styles.mainArea}>
        <div className={mergeClasses(styles.mainContent, activeApp !== 'chat' && styles.mainContentHidden)}>
          <OmniAgentsApp uiUrl={uiSrc} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables} onReady={handleUiReady} headerActionsTargetId={headerActionsTargetId} headerActionsCompact={headerActionsCompact} sandboxLabel={sandboxLabel} onClientToolCall={onClientToolCall} pendingPlan={pendingPlan} onPlanDecision={onPlanDecision} />
        </div>
        <AnimatePresence>
          {activeApp !== 'chat' && activeDescriptor && (
            <AppSurfaceView
              app={activeDescriptor}
              src={surfaceSrc}
              onUrlChange={activeDescriptor.kind === 'builtin-browser' ? onPreviewUrlChange : undefined}
              isGlass={isGlass}
              tabId={tabId}
            />
          )}
        </AnimatePresence>
      </div>
      {(() => {
        const dock = (
          <EnvironmentDock
            apps={dockApps}
            activeAppId={activeApp}
            onSelect={handleDockSelect}
            sandboxUrls={sandboxUrls}
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
