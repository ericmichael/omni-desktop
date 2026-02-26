import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiMonitorBold, PiWarningCircleFill } from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { Webview } from '@/renderer/common/Webview';
import { Button, cn, Divider, Heading, Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
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
    store: { layoutMode: LayoutMode; theme: OmniTheme };
    onReady: () => void;
  }) => {
    const layoutMode = store.layoutMode ?? 'work';
    const [uiWorkReady, setUiWorkReady] = useState(false);
    const [vncDesktopReady, setVncDesktopReady] = useState(false);
    const [codeLayoutReady, setCodeLayoutReady] = useState(false);

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

    const hasVnc = Boolean(vncSrc);
    const [vncOverlayOpen, setVncOverlayOpen] = useState(false);

    const handleOpenVncOverlay = useCallback(() => {
      setVncOverlayOpen(true);
    }, []);

    const handleCloseVncOverlay = useCallback(() => {
      setVncOverlayOpen(false);
    }, []);

    const allReady = useMemo(() => {
      if (layoutMode === 'work') {
        return uiWorkReady;
      }
      if (layoutMode === 'desktop') {
        return hasVnc ? vncDesktopReady : true;
      }
      return codeLayoutReady;
    }, [codeLayoutReady, hasVnc, layoutMode, uiWorkReady, vncDesktopReady]);

    useEffect(() => {
      if (allReady) {
        onReady();
      }
    }, [allReady, onReady]);

    const handleUiWorkReady = useCallback(() => {
      setUiWorkReady(true);
    }, []);

    const handleVncDesktopReady = useCallback(() => {
      setVncDesktopReady(true);
    }, []);

    const handleCodeLayoutReady = useCallback(() => {
      setCodeLayoutReady(true);
    }, []);

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <div className={cn('w-full h-full relative', layoutMode !== 'work' && 'hidden')}>
            <Webview src={uiSrc} onReady={handleUiWorkReady} showUnavailable={false} />
            {vncSrc && (
              <FloatingWidget
                src={vncSrc}
                label="Omni's PC"
                icon={PiMonitorBold}
                overlayOpen={vncOverlayOpen}
                onOpenOverlay={handleOpenVncOverlay}
                onCloseOverlay={handleCloseVncOverlay}
                className="top-[75%]"
                resizable
              />
            )}
          </div>

          <div className={cn('w-full h-full', layoutMode !== 'desktop' && 'hidden')}>
            <Webview src={vncSrc} onReady={handleVncDesktopReady} showUnavailable={hasVnc} />
          </div>

          <div className={cn('w-full h-full relative', layoutMode !== 'code' && 'hidden')}>
            <CodeSplitLayout
              uiSrc={uiSrc}
              codeServerSrc={codeServerSrc}
              onReady={handleCodeLayoutReady}
            />
            {vncSrc && (
              <FloatingWidget
                src={vncSrc}
                label="Omni's PC"
                icon={PiMonitorBold}
                overlayOpen={vncOverlayOpen}
                onOpenOverlay={handleOpenVncOverlay}
                onCloseOverlay={handleCloseVncOverlay}
                className="top-[75%]"
                resizable
              />
            )}
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
