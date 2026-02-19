import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiArrowLeftBold, PiArrowsOutSimpleBold, PiCaretDownBold, PiStopFill, PiWarningCircleFill } from 'react-icons/pi';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { Button, cn, Divider, Heading, IconButton, Spinner } from '@/renderer/ds';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

import {
  $omniInstallProcessXTerm,
  $omniRuntimeInfo,
  $sandboxProcessStatus,
  $sandboxProcessXTerm,
  omniInstallApi,
  sandboxApi,
} from './state';
import type { AutoLaunchPhase } from './use-auto-launch';
import { $autoLaunchError, $autoLaunchPhase, useAutoLaunch } from './use-auto-launch';

const MIN_SIDEBAR_PERCENT = 20;
const MAX_SIDEBAR_PERCENT = 50;
const DEFAULT_SIDEBAR_PERCENT = 30;
const DESKTOP_PANEL_EXPANDED_HEIGHT = 200;

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

const Webview = ({
  src,
  isActive = true,
  onReady,
  showUnavailable = true,
}: {
  src?: string;
  isActive?: boolean;
  onReady?: () => void;
  showUnavailable?: boolean;
}) => {
  const elementRef = useRef<Electron.WebviewTag | null>(null);
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
      el.reload();
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

      const el = node as unknown as Electron.WebviewTag;
      elementRef.current = el;

      let initialTimer: ReturnType<typeof setTimeout> | null = null;

      const onLoad = () => {
        if (initialTimer) {
          clearTimeout(initialTimer);
          initialTimer = null;
        }
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

      initialTimer = setTimeout(() => {
        if (!readyEmittedRef.current) {
          el.reload();
        }
      }, 500);

      cleanupRef.current = () => {
        if (initialTimer) {
          clearTimeout(initialTimer);
        }
        el.removeEventListener('did-finish-load', onLoad);
        el.removeEventListener('did-fail-load', onFailLoad);
      };
    },
    [clearRetryTimer, scheduleRetry, src]
  );

  useEffect(() => {
    if (!isActive || !src || readyEmittedRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      if (!readyEmittedRef.current) {
        elementRef.current?.reload();
      }
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [isActive, src]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      clearRetryTimer();
    };
  }, [clearRetryTimer]);

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

  return <webview ref={callbackRef} src={src} style={{ width: '100%', height: '100%' }} />;
};

const PHASE_LABELS: Partial<Record<AutoLaunchPhase, string>> = {
  checking: 'Checking runtime',
  installing: 'Installing runtime',
  ready: 'Preparing workspace',
  starting: 'Starting sandbox',
  waiting: 'Waiting for services',
};

const PHASE_ORDER: AutoLaunchPhase[] = ['checking', 'installing', 'ready', 'starting', 'waiting'];

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
              Omni Sandbox
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
              Launch Sandbox
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

const modeOptions: { value: LayoutMode; label: string }[] = [
  { value: 'work', label: 'Work' },
  { value: 'code', label: 'Code' },
];

const setLayoutMode = (mode: LayoutMode) => {
  persistedStoreApi.setKey('layoutMode', mode);
};

const OmniRunningView = memo(
  ({
    sandboxUrls,
    store,
    phase,
  }: {
    sandboxUrls: {
      uiUrl: string;
      codeServerUrl?: string;
      noVncUrl?: string;
    };
    store: { enableCodeServer: boolean; enableVnc: boolean; layoutMode: LayoutMode };
    phase: AutoLaunchPhase;
  }) => {
    const layoutMode = store.layoutMode ?? 'work';
    const splitRef = useRef<HTMLDivElement>(null);
    const [sidebarWidthPercent, setSidebarWidthPercent] = useState(DEFAULT_SIDEBAR_PERCENT);
    const [desktopExpanded, setDesktopExpanded] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [uiWorkReady, setUiWorkReady] = useState(false);
    const [uiSidebarReady, setUiSidebarReady] = useState(false);
    const [codeServerReady, setCodeServerReady] = useState(false);
    const [vncDesktopReady, setVncDesktopReady] = useState(false);
    const [vncPanelReady, setVncPanelReady] = useState(false);

    const canLoadWebviews = phase === 'running';
    const uiSrc = canLoadWebviews ? sandboxUrls.uiUrl : undefined;
    const codeServerSrc = canLoadWebviews ? sandboxUrls.codeServerUrl : undefined;
    const vncSrc = canLoadWebviews ? sandboxUrls.noVncUrl : undefined;

    const isOverlayVisible = useMemo(() => {
      if (!canLoadWebviews) {
        return true;
      }

      if (layoutMode === 'work') {
        return !uiWorkReady;
      }

      if (layoutMode === 'desktop') {
        return store.enableVnc ? !vncDesktopReady : false;
      }

      const codeReady = store.enableCodeServer ? codeServerReady : true;
      const uiReady = uiSidebarReady;
      const vncReady = store.enableVnc && desktopExpanded ? vncPanelReady : true;
      return !(codeReady && uiReady && vncReady);
    }, [
      canLoadWebviews,
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

    const stopSandbox = useCallback(() => {
      sandboxApi.stop();
    }, []);

    const handleSetMode = useCallback(
      (mode: LayoutMode) => () => {
        setLayoutMode(mode);
      },
      []
    );

    const handleBackToCode = useCallback(() => {
      setLayoutMode('code');
    }, []);

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

    const availableModes = useMemo(() => {
      if (!store.enableCodeServer) {
        return modeOptions.filter((m) => m.value === 'work');
      }
      return modeOptions;
    }, [store.enableCodeServer]);

    const overlayLabel = canLoadWebviews ? 'Loading UI' : (PHASE_LABELS[phase] ?? 'Starting');

    return (
      <div className="flex flex-col w-full h-full relative">
        {/* Toolbar */}
        <div className="flex items-center px-3 border-b border-surface-border shrink-0">
          <AsciiLogo className="text-[6px]" />

          <div className="flex-1 flex justify-center">
            {layoutMode === 'desktop' ? (
              <Button size="sm" variant="ghost" onClick={handleBackToCode}>
                <PiArrowLeftBold size={14} />
                <span className="ml-1">Back to Code</span>
              </Button>
            ) : (
              <div className="flex bg-surface-raised rounded-lg p-0.5 gap-0.5">
                {availableModes.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={handleSetMode(opt.value)}
                    className={cn(
                      'relative px-3 py-1 text-xs rounded-md transition-colors cursor-pointer select-none',
                      layoutMode === opt.value ? 'text-white' : 'text-fg-muted hover:text-fg'
                    )}
                  >
                    {layoutMode === opt.value && (
                      <motion.div
                        layoutId="layout-indicator"
                        className="absolute inset-0 bg-accent-600 rounded-md"
                        transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
                      />
                    )}
                    <span className="relative z-10">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <SettingsModalOpenButton />
            <IconButton aria-label="Stop sandbox" icon={<PiStopFill />} size="sm" onClick={stopSandbox} />
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0 p-2 relative">
          <div className={cn('w-full h-full', layoutMode !== 'work' && 'hidden')}>
            <Webview src={uiSrc} isActive={layoutMode === 'work'} onReady={() => setUiWorkReady(true)} showUnavailable={false} />
          </div>

          <div className={cn('w-full h-full', layoutMode !== 'desktop' && 'hidden')}>
            <Webview
              src={store.enableVnc ? vncSrc : undefined}
              isActive={layoutMode === 'desktop'}
              onReady={() => setVncDesktopReady(true)}
              showUnavailable={store.enableVnc}
            />
          </div>

          <div className={cn('w-full h-full', layoutMode !== 'code' && 'hidden')}>
            <div ref={splitRef} className={cn('relative flex w-full h-full', isDragging && 'select-none')}>
              {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

              <div className="min-w-0" style={{ width: `${100 - sidebarWidthPercent}%` }}>
                <Webview
                  src={store.enableCodeServer ? codeServerSrc : undefined}
                  isActive={layoutMode === 'code'}
                  onReady={() => setCodeServerReady(true)}
                  showUnavailable={store.enableCodeServer}
                />
              </div>

              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
                onMouseDown={handleDividerMouseDown}
              />

              <div className="flex flex-col min-w-0" style={{ width: `${sidebarWidthPercent}%` }}>
                <div className="flex-1 min-h-0">
                  <Webview
                    src={uiSrc}
                    isActive={layoutMode === 'code'}
                    onReady={() => setUiSidebarReady(true)}
                    showUnavailable={false}
                  />
                </div>

                {store.enableVnc && (
                  <>
                    <div className="flex items-center justify-between px-2 h-8 shrink-0 border-t border-surface-border bg-surface-raised">
                      <button
                        onClick={toggleDesktop}
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
                        className="text-fg-muted hover:text-fg cursor-pointer p-1"
                        title="Expand Desktop to full screen"
                      >
                        <PiArrowsOutSimpleBold size={12} />
                      </button>
                    </div>
                    <div
                      className={cn('shrink-0 transition-[height] overflow-hidden', !desktopExpanded && 'h-0')}
                      style={{ height: desktopExpanded ? DESKTOP_PANEL_EXPANDED_HEIGHT : 0 }}
                    >
                      <Webview
                        src={vncSrc}
                        isActive={layoutMode === 'code' && desktopExpanded}
                        onReady={() => setVncPanelReady(true)}
                        showUnavailable={false}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {isOverlayVisible && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-surface/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <Spinner size="lg" />
                <EllipsisLoadingText className="text-sm text-fg-muted">{overlayLabel}</EllipsisLoadingText>
              </div>
            </div>
          )}
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

  useAutoLaunch();

  const sandboxUrls = useMemo(() => {
    if (sandboxStatus.type !== 'running') {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  if (!initialized) {
    return null;
  }

  if (sandboxUrls) {
    return <OmniRunningView sandboxUrls={sandboxUrls} store={store} phase={phase} />;
  }

  return (
    <AnimatePresence mode="wait">
      {phase === 'error' && (
        <motion.div
          key="error"
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="w-full h-full"
        >
          <OmniErrorView />
        </motion.div>
      )}
      {phase === 'idle' && (
        <motion.div
          key="idle"
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="w-full h-full"
        >
          <OmniIdleView />
        </motion.div>
      )}
      {phase !== 'error' && phase !== 'idle' && (
        <motion.div
          key="progress"
          variants={fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="w-full h-full"
        >
          <OmniProgressView />
        </motion.div>
      )}
    </AnimatePresence>
  );
});

Omni.displayName = 'Omni';
