import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiArrowsOutSimpleBold, PiCaretDownBold, PiWarningCircleFill } from 'react-icons/pi';

import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { Webview } from '@/renderer/common/Webview';
import { Button, cn, Divider, Heading, Spinner } from '@/renderer/ds';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode, OmniTheme } from '@/shared/types';

import {
  $omniInstallProcessXTerm,
  $omniRuntimeInfo,
  $sandboxProcessStatus,
  $sandboxProcessXTerm,
  omniInstallApi,
} from './state';
import type { AutoLaunchPhase } from './use-auto-launch';
import { $autoLaunchError, $autoLaunchPhase, useAutoLaunch } from './use-auto-launch';

const stopPropagation = (e: React.MouseEvent) => {
  e.stopPropagation();
};

const MIN_SIDEBAR_PERCENT = 20;
const MAX_SIDEBAR_PERCENT = 50;
const DEFAULT_SIDEBAR_PERCENT = 30;
const DEFAULT_DESKTOP_PANEL_HEIGHT = 200;
const MIN_DESKTOP_PANEL_HEIGHT = 80;
const MAX_DESKTOP_PANEL_PERCENT = 0.6;
const CONTENT_READY_TIMEOUT_MS = 10_000;

const fadeVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.05 } },
};

const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

const PHASE_LABELS: Partial<Record<AutoLaunchPhase, string>> = {
  checking: 'Checking runtime',
  installing: 'Installing runtime',
  ready: 'Preparing workspace',
  starting: 'Starting services',
  running: 'Loading interface',
};

const PHASE_ORDER: AutoLaunchPhase[] = ['checking', 'installing', 'ready', 'starting', 'running'];

const OmniProgressView = memo(() => {
  const phase = useStore($autoLaunchPhase);
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  const sandboxXTerm = useStore($sandboxProcessXTerm);
  const [showLogs, setShowLogs] = useState(false);

  const label = PHASE_LABELS[phase] ?? 'Starting';
  const hasLogs = phase === 'installing' ? Boolean(omniInstallXTerm) : Boolean(sandboxXTerm);

  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => !prev);
  }, []);

  const cancelInstall = useCallback(() => {
    omniInstallApi.cancelInstall();
  }, []);

  const currentPhaseIndex = PHASE_ORDER.indexOf(phase);

  return (
    <BodyContainer>
      <BodyContent className="justify-center items-center">
        <motion.div
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex flex-col items-center gap-6 max-w-md"
        >
          <Spinner size="lg" />

          <div className="flex items-center gap-3">
            {PHASE_ORDER.map((p, i) => (
              <div key={p} className="flex items-center gap-3">
                <div
                  className={cn(
                    'size-2 rounded-full transition-colors',
                    i < currentPhaseIndex && 'bg-accent-500',
                    i === currentPhaseIndex && 'bg-accent-400 animate-pulse',
                    i > currentPhaseIndex && 'bg-surface-overlay'
                  )}
                />
                {i < PHASE_ORDER.length - 1 && <div className="w-6 h-px bg-surface-border" />}
              </div>
            ))}
          </div>

          <EllipsisLoadingText className="text-sm text-fg-muted">{label}</EllipsisLoadingText>

          <div className="flex items-center gap-2">
            {hasLogs && (
              <Button size="sm" variant="ghost" onClick={toggleLogs}>
                {showLogs ? 'Hide details' : 'Show details'}
              </Button>
            )}
            {phase === 'installing' && (
              <Button size="sm" variant="destructive" onClick={cancelInstall}>
                Cancel
              </Button>
            )}
          </div>

          <AnimatePresence>
            {showLogs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 300, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
                className="w-full min-w-[500px] overflow-hidden"
              >
                {phase === 'installing' ? (
                  <XTermLogViewer $xterm={$omniInstallProcessXTerm} />
                ) : (
                  <XTermLogViewer $xterm={$sandboxProcessXTerm} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
OmniProgressView.displayName = 'OmniProgressView';

const OmniErrorView = memo(() => {
  const error = useStore($autoLaunchError);
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  const sandboxXTerm = useStore($sandboxProcessXTerm);
  const { retry } = useAutoLaunch();
  const [showLogs, setShowLogs] = useState(false);

  const hasLogs = Boolean(omniInstallXTerm) || Boolean(sandboxXTerm);

  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => !prev);
  }, []);

  return (
    <BodyContainer>
      <BodyContent className="justify-center items-center">
        <motion.div
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex flex-col items-center gap-6 max-w-md"
        >
          <PiWarningCircleFill className="text-fg-error" size={32} />
          <Heading size="md">Something went wrong</Heading>

          <div className="bg-red-400/5 border border-red-400/20 rounded-lg p-4 w-full">
            <span className="text-fg-error text-sm text-center block">{error ?? 'An unexpected error occurred.'}</span>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={retry}>Retry</Button>
            {hasLogs && (
              <Button size="sm" variant="ghost" onClick={toggleLogs}>
                {showLogs ? 'Hide details' : 'Show details'}
              </Button>
            )}
          </div>

          <AnimatePresence>
            {showLogs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 300, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
                className="w-full min-w-[500px] overflow-hidden"
              >
                {omniInstallXTerm ? (
                  <XTermLogViewer $xterm={$omniInstallProcessXTerm} />
                ) : (
                  <XTermLogViewer $xterm={$sandboxProcessXTerm} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
OmniErrorView.displayName = 'OmniErrorView';

const OmniIdleView = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const { launch } = useAutoLaunch();

  const openSettings = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);

  return (
    <BodyContainer>
      <BodyContent className="justify-center items-center">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.08), transparent 70%)' }}
        />
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="flex flex-col items-center gap-6 max-w-md relative z-10"
        >
          <motion.div variants={staggerItem}>
            <Heading size="lg" as="h1">
              Omni Code
            </Heading>
          </motion.div>

          <motion.div variants={staggerItem} className="flex items-center gap-3">
            {runtimeInfo.isInstalled && (
              <span className="bg-white/5 px-3 py-1 rounded-full text-xs text-fg-muted">
                Runtime v{runtimeInfo.version}
              </span>
            )}
            {runtimeInfo.isInstalled && store.workspaceDir && <Divider orientation="vertical" className="h-4" />}
            {store.workspaceDir && (
              <span className="bg-white/5 px-3 py-1 rounded-full text-xs text-fg-muted truncate max-w-[250px]">
                {store.workspaceDir}
              </span>
            )}
          </motion.div>

          <motion.div variants={staggerItem}>
            <Button size="lg" onClick={launch} isDisabled={!store.workspaceDir} className="animate-pulse-glow">
              Launch
            </Button>
          </motion.div>

          <motion.div variants={staggerItem}>
            <Button size="sm" variant="link" onClick={openSettings}>
              Settings
            </Button>
          </motion.div>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
OmniIdleView.displayName = 'OmniIdleView';

const setLayoutMode = (mode: LayoutMode) => {
  persistedStoreApi.setKey('layoutMode', mode);
};

const OmniRunningView = memo(
  ({
    sandboxUrls,
    store,
    onReady,
  }: {
    sandboxUrls: {
      uiUrl: string;
      codeServerUrl?: string;
      noVncUrl?: string;
    };
    store: { enableCodeServer: boolean; enableVnc: boolean; layoutMode: LayoutMode; theme: OmniTheme };
    onReady: () => void;
  }) => {
    const layoutMode = store.layoutMode ?? 'work';
    const splitRef = useRef<HTMLDivElement>(null);
    const [sidebarWidthPercent, setSidebarWidthPercent] = useState(DEFAULT_SIDEBAR_PERCENT);
    const [desktopExpanded, setDesktopExpanded] = useState(false);
    const [desktopHeight, setDesktopHeight] = useState(DEFAULT_DESKTOP_PANEL_HEIGHT);
    const [isDragging, setIsDragging] = useState(false);
    const [isDesktopDragging, setIsDesktopDragging] = useState(false);
    const sidebarRef = useRef<HTMLDivElement>(null);
    const [uiWorkReady, setUiWorkReady] = useState(false);
    const [uiSidebarReady, setUiSidebarReady] = useState(false);
    const [codeServerReady, setCodeServerReady] = useState(false);
    const [vncDesktopReady, setVncDesktopReady] = useState(false);
    const [vncPanelReady, setVncPanelReady] = useState(false);

    const theme = store.theme ?? 'tokyo-night';
    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme]);
    const codeServerSrc = sandboxUrls.codeServerUrl;
    const vncSrc = sandboxUrls.noVncUrl;

    // Signal readiness to parent when all webviews for the current layout have loaded
    const allReady = useMemo(() => {
      if (layoutMode === 'work') {
        return uiWorkReady;
      }

      if (layoutMode === 'desktop') {
        return store.enableVnc ? vncDesktopReady : true;
      }

      const codeReady = store.enableCodeServer ? codeServerReady : true;
      const uiReady = uiSidebarReady;
      const vncReady = store.enableVnc && desktopExpanded ? vncPanelReady : true;
      return codeReady && uiReady && vncReady;
    }, [
      codeServerReady,
      desktopExpanded,
      layoutMode,
      store.enableCodeServer,
      store.enableVnc,
      uiSidebarReady,
      uiWorkReady,
      vncDesktopReady,
      vncPanelReady,
    ]);

    useEffect(() => {
      if (allReady) {
        onReady();
      }
    }, [allReady, onReady]);

    const handleExpandDesktop = useCallback(() => {
      setLayoutMode('desktop');
    }, []);

    const toggleDesktop = useCallback(() => {
      setDesktopExpanded((prev) => !prev);
    }, []);

    const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
    }, []);

    useEffect(() => {
      if (!isDragging) {
        return;
      }

      const handleMouseMove = (e: MouseEvent) => {
        if (!splitRef.current) {
          return;
        }
        const rect = splitRef.current.getBoundingClientRect();
        const percent = ((rect.right - e.clientX) / rect.width) * 100;
        const clamped = Math.min(MAX_SIDEBAR_PERCENT, Math.max(MIN_SIDEBAR_PERCENT, percent));
        setSidebarWidthPercent(clamped);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }, [isDragging]);

    const handleDesktopDividerMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      setIsDesktopDragging(true);
    }, []);

    useEffect(() => {
      if (!isDesktopDragging) {
        return;
      }

      const handleMouseMove = (e: MouseEvent) => {
        if (!sidebarRef.current) {
          return;
        }
        const rect = sidebarRef.current.getBoundingClientRect();
        const height = rect.bottom - e.clientY;
        const maxHeight = rect.height * MAX_DESKTOP_PANEL_PERCENT;
        const clamped = Math.min(maxHeight, Math.max(MIN_DESKTOP_PANEL_HEIGHT, height));
        setDesktopHeight(clamped);
      };

      const handleMouseUp = () => {
        setIsDesktopDragging(false);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }, [isDesktopDragging]);

    const handleUiWorkReady = useCallback(() => {
      setUiWorkReady(true);
    }, []);

    const handleUiSidebarReady = useCallback(() => {
      setUiSidebarReady(true);
    }, []);

    const handleCodeServerReady = useCallback(() => {
      setCodeServerReady(true);
    }, []);

    const handleVncDesktopReady = useCallback(() => {
      setVncDesktopReady(true);
    }, []);

    const handleVncPanelReady = useCallback(() => {
      setVncPanelReady(true);
    }, []);

    return (
      <div className="flex flex-col w-full h-full relative">
        {/* Content area */}
        <div className="flex-1 min-h-0 p-2 relative">
          <div className={cn('w-full h-full', layoutMode !== 'work' && 'hidden')}>
            <Webview src={uiSrc} onReady={handleUiWorkReady} showUnavailable={false} />
          </div>

          <div className={cn('w-full h-full', layoutMode !== 'desktop' && 'hidden')}>
            <Webview
              src={store.enableVnc ? vncSrc : undefined}
              onReady={handleVncDesktopReady}
              showUnavailable={store.enableVnc}
            />
          </div>

          <div className={cn('w-full h-full', layoutMode !== 'code' && 'hidden')}>
            <div
              ref={splitRef}
              className={cn('relative flex w-full h-full', (isDragging || isDesktopDragging) && 'select-none')}
            >
              {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

              <div className="min-w-0" style={{ width: `${100 - sidebarWidthPercent}%` }}>
                <Webview
                  src={store.enableCodeServer ? codeServerSrc : undefined}
                  onReady={handleCodeServerReady}
                  showUnavailable={store.enableCodeServer}
                />
              </div>

              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
                onMouseDown={handleDividerMouseDown}
              />

              <div ref={sidebarRef} className="flex flex-col min-w-0" style={{ width: `${sidebarWidthPercent}%` }}>
                {isDesktopDragging && <div className="absolute inset-0 z-20 cursor-row-resize" />}
                <div className="flex-1 min-h-0">
                  <Webview src={uiSrc} onReady={handleUiSidebarReady} showUnavailable={false} />
                </div>

                {store.enableVnc && (
                  <>
                    <div
                      className={cn(
                        'flex items-center justify-between px-2 h-8 shrink-0 border-t border-surface-border bg-surface-raised',
                        desktopExpanded && 'cursor-row-resize'
                      )}
                      onMouseDown={desktopExpanded ? handleDesktopDividerMouseDown : undefined}
                    >
                      <button
                        onClick={toggleDesktop}
                        onMouseDown={stopPropagation}
                        className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg cursor-pointer select-none"
                      >
                        <PiCaretDownBold
                          size={10}
                          className={cn('transition-transform', !desktopExpanded && '-rotate-90')}
                        />
                        <span>Desktop</span>
                      </button>
                      <button
                        onClick={handleExpandDesktop}
                        onMouseDown={stopPropagation}
                        className="text-fg-muted hover:text-fg cursor-pointer p-1"
                        title="Expand Desktop to full screen"
                      >
                        <PiArrowsOutSimpleBold size={12} />
                      </button>
                    </div>
                    <div
                      className={cn(
                        'shrink-0 overflow-hidden',
                        !desktopExpanded && 'h-0',
                        !isDesktopDragging && 'transition-[height]'
                      )}
                      style={{ height: desktopExpanded ? desktopHeight : 0 }}
                    >
                      <Webview src={vncSrc} onReady={handleVncPanelReady} showUnavailable={false} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
OmniRunningView.displayName = 'OmniRunningView';

export const Omni = memo(() => {
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);
  const sandboxStatus = useStore($sandboxProcessStatus);
  const phase = useStore($autoLaunchPhase);
  const [contentReady, setContentReady] = useState(false);

  useAutoLaunch();

  const sandboxUrls = useMemo(() => {
    if (sandboxStatus.type !== 'running') {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  // Reset when sandbox stops
  useEffect(() => {
    if (!sandboxUrls) {
      setContentReady(false);
    }
  }, [sandboxUrls]);

  // Safety timeout: force-show content after 10s even if webviews haven't reported ready
  useEffect(() => {
    if (!sandboxUrls || contentReady) {
      return;
    }
    const timer = setTimeout(() => {
      setContentReady(true);
    }, CONTENT_READY_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [sandboxUrls, contentReady]);

  const handleContentReady = useCallback(() => {
    setContentReady(true);
  }, []);

  if (!initialized) {
    return null;
  }

  // Render structure: running view behind, overlay content on top.
  // OmniRunningView mounts as soon as we have URLs so webviews start loading,
  // while the progress overlay stays visible until webviews are ready.
  return (
    <div className="w-full h-full relative">
      {sandboxUrls && <OmniRunningView sandboxUrls={sandboxUrls} store={store} onReady={handleContentReady} />}

      <AnimatePresence mode="wait">
        {phase === 'error' && !sandboxUrls && (
          <motion.div
            key="error"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40"
          >
            <OmniErrorView />
          </motion.div>
        )}
        {phase === 'idle' && !sandboxUrls && (
          <motion.div
            key="idle"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40"
          >
            <OmniIdleView />
          </motion.div>
        )}
        {!contentReady && phase !== 'error' && phase !== 'idle' && (
          <motion.div
            key="progress"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40 bg-surface"
          >
            <OmniProgressView />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

Omni.displayName = 'Omni';
