import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiWarningCircleFill } from 'react-icons/pi';

import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { Webview } from '@/renderer/common/Webview';
import { Button, Heading, Spinner } from '@/renderer/ds';
import {
  $omniInstallProcessStatus,
  $omniInstallProcessXTerm,
  $omniRuntimeInfo,
  omniInstallApi,
  refreshOmniRuntimeInfo,
} from '@/renderer/features/Omni/state';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus, $chatProcessXTerm, chatApi } from './state';

type ChatPhase = 'checking' | 'installing' | 'ready' | 'starting' | 'running' | 'error' | 'idle';

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

const PHASE_LABELS: Partial<Record<ChatPhase, string>> = {
  checking: 'Checking runtime',
  installing: 'Installing runtime',
  ready: 'Preparing',
  starting: 'Starting chat',
  running: 'Loading interface',
};

const PHASE_ORDER: ChatPhase[] = ['checking', 'installing', 'ready', 'starting', 'running'];

const useChatAutoLaunch = () => {
  const initialized = useStore($initialized);
  const installStatus = useStore($omniInstallProcessStatus);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);

  const [phase, setPhase] = useState<ChatPhase>('checking');
  const [error, setError] = useState<string | null>(null);

  const hasAutoLaunched = useRef(false);
  const didTriggerInstall = useRef(false);
  const didTriggerStart = useRef(false);
  const lastStartTimestamp = useRef<number | null>(null);

  // Phase: checking → installing or ready
  // We must fetch fresh runtime info before deciding, because the $omniRuntimeInfo atom
  // initializes as { isInstalled: false } and the module-level refresh may not have
  // resolved yet, causing a spurious install on every launch.
  useEffect(() => {
    if (!initialized || phase !== 'checking') {
      return;
    }

    let cancelled = false;
    refreshOmniRuntimeInfo().then(() => {
      if (cancelled) {
        return;
      }
      const info = $omniRuntimeInfo.get();
      if (info.isInstalled) {
        setPhase('ready');
      } else {
        didTriggerInstall.current = true;
        omniInstallApi.startInstall(false);
        setPhase('installing');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialized, phase]);

  // Phase: installing → ready or error
  useEffect(() => {
    if (phase !== 'installing') {
      return;
    }

    if (installStatus.type === 'completed') {
      refreshOmniRuntimeInfo();
      setPhase('ready');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'error') {
      setError(installStatus.error.message);
      setPhase('error');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'canceled') {
      setPhase('idle');
      didTriggerInstall.current = false;
    }
  }, [phase, installStatus]);

  // Phase: ready → starting
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }

    if (!store.workspaceDir) {
      setError('No workspace directory configured.');
      setPhase('error');
      return;
    }

    if (hasAutoLaunched.current) {
      setPhase('idle');
      return;
    }

    let cancelled = false;

    const startChat = async () => {
      // Verify models are configured
      try {
        const configDir = await emitter.invoke('config:get-omni-config-dir');
        const modelsConfig = (await emitter.invoke('config:read-json-file', `${configDir}/models.json`)) as {
          providers?: Record<string, unknown>;
        } | null;
        const hasProviders = modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0;

        if (cancelled) {
          return;
        }

        if (!hasProviders) {
          await persistedStoreApi.setKey('onboardingComplete', false);
          return;
        }
      } catch {
        // proceed anyway
      }

      if (cancelled) {
        return;
      }

      hasAutoLaunched.current = true;
      didTriggerStart.current = true;
      lastStartTimestamp.current = Date.now();
      chatApi.start({ workspaceDir: store.workspaceDir! });
      setPhase('starting');
    };

    void startChat();

    return () => {
      cancelled = true;
    };
  }, [phase, store]);

  // Phase: starting → running or error/idle
  useEffect(() => {
    if (phase !== 'starting') {
      return;
    }

    if (chatStatus.type === 'running') {
      setPhase('running');
      didTriggerStart.current = false;
    } else if (chatStatus.type === 'error') {
      setError(chatStatus.error.message);
      setPhase('error');
      didTriggerStart.current = false;
    } else if (chatStatus.type === 'exited') {
      const startTs = lastStartTimestamp.current;
      if (!startTs || chatStatus.timestamp > startTs) {
        setPhase('idle');
        didTriggerStart.current = false;
      }
    }
  }, [phase, chatStatus]);

  // running → idle when chat stops
  useEffect(() => {
    if (phase !== 'running') {
      return;
    }

    if (chatStatus.type === 'exited' || chatStatus.type === 'error') {
      setPhase('idle');
    }
  }, [phase, chatStatus]);

  const retry = useCallback(() => {
    setError(null);
    setPhase('checking');
  }, []);

  const launch = useCallback(() => {
    if (!store.workspaceDir) {
      return;
    }
    hasAutoLaunched.current = false;
    setPhase('ready');
  }, [store.workspaceDir]);

  return { phase, error, retry, launch };
};

const ChatProgressView = memo(({ phase }: { phase: ChatPhase }) => {
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  const chatXTerm = useStore($chatProcessXTerm);
  const [showLogs, setShowLogs] = useState(false);

  const label = PHASE_LABELS[phase] ?? 'Starting';
  const hasLogs = phase === 'installing' ? Boolean(omniInstallXTerm) : Boolean(chatXTerm);

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
                  className={`size-2 rounded-full transition-colors ${
                    i < currentPhaseIndex
                      ? 'bg-accent-500'
                      : i === currentPhaseIndex
                        ? 'bg-accent-400 animate-pulse'
                        : 'bg-surface-overlay'
                  }`}
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
                  <XTermLogViewer $xterm={$chatProcessXTerm} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
ChatProgressView.displayName = 'ChatProgressView';

const ChatErrorView = memo(({ error, onRetry }: { error: string | null; onRetry: () => void }) => {
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  const chatXTerm = useStore($chatProcessXTerm);
  const [showLogs, setShowLogs] = useState(false);

  const hasLogs = Boolean(omniInstallXTerm) || Boolean(chatXTerm);

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
            <Button onClick={onRetry}>Retry</Button>
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
                  <XTermLogViewer $xterm={$chatProcessXTerm} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
ChatErrorView.displayName = 'ChatErrorView';

const ChatIdleView = memo(({ onLaunch }: { onLaunch: () => void }) => {
  const store = useStore(persistedStoreApi.$atom);
  const runtimeInfo = useStore($omniRuntimeInfo);

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
              Chat
            </Heading>
          </motion.div>

          <motion.div variants={staggerItem}>
            <span className="text-sm text-fg-muted text-center block">
              Run the Omni Code web UI locally — no Docker required.
            </span>
          </motion.div>

          <motion.div variants={staggerItem} className="flex items-center gap-3">
            {runtimeInfo.isInstalled && (
              <span className="bg-white/5 px-3 py-1 rounded-full text-xs text-fg-muted">
                Runtime v{runtimeInfo.version}
              </span>
            )}
          </motion.div>

          <motion.div variants={staggerItem}>
            <Button size="lg" onClick={onLaunch} isDisabled={!store.workspaceDir} className="animate-pulse-glow">
              Start Chat
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
ChatIdleView.displayName = 'ChatIdleView';

export const Chat = memo(() => {
  const initialized = useStore($initialized);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch } = useChatAutoLaunch();
  const [contentReady, setContentReady] = useState(false);

  const theme = store.theme ?? 'tokyo-night';

  const uiUrl = useMemo(() => {
    if (chatStatus.type !== 'running') {
      return null;
    }
    const url = new URL(chatStatus.data.uiUrl);
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    return url.toString();
  }, [chatStatus, theme]);

  // Reset when chat stops
  useEffect(() => {
    if (!uiUrl) {
      setContentReady(false);
    }
  }, [uiUrl]);

  // Safety timeout: force-show content after 10s
  useEffect(() => {
    if (!uiUrl || contentReady) {
      return;
    }
    const timer = setTimeout(() => {
      setContentReady(true);
    }, CONTENT_READY_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [uiUrl, contentReady]);

  const handleContentReady = useCallback(() => {
    setContentReady(true);
  }, []);

  if (!initialized) {
    return null;
  }

  return (
    <div className="w-full h-full relative">
      {uiUrl && (
        <div className="flex flex-col w-full h-full relative">
          <div className="flex-1 min-h-0 relative">
            <Webview src={uiUrl} onReady={handleContentReady} showUnavailable={false} />
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        {phase === 'error' && !uiUrl && (
          <motion.div
            key="error"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40"
          >
            <ChatErrorView error={error} onRetry={retry} />
          </motion.div>
        )}
        {phase === 'idle' && !uiUrl && (
          <motion.div
            key="idle"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40"
          >
            <ChatIdleView onLaunch={launch} />
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
            <ChatProgressView phase={phase} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

Chat.displayName = 'Chat';
