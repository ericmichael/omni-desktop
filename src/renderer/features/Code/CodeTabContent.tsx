import { useStore } from '@nanostores/react';
import type { Terminal } from '@xterm/xterm';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReadableAtom } from 'nanostores';
import { computed } from 'nanostores';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiMonitorBold, PiWarningCircleFill } from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { EllipsisLoadingText } from '@/renderer/common/EllipsisLoadingText';
import { BodyContainer, BodyContent } from '@/renderer/common/layout';
import { Button, cn, Heading, Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { $omniInstallProcessXTerm } from '@/renderer/features/Omni/state';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId } from '@/shared/types';

import { CodeEmptyState } from './CodeEmptyState';
import { $codeTabErrors, $codeTabPhases, $codeTabStatuses, $codeTabXTerms } from './state';
import type { AutoLaunchPhase } from './use-code-auto-launch';
import { useCodeAutoLaunch } from './use-code-auto-launch';

/** Cache of per-tab computed atoms so we don't create new ones on every render. */
const tabXTermAtomCache = new Map<CodeTabId, ReadableAtom<Terminal | null>>();
const getTabXTermAtom = (tabId: CodeTabId): ReadableAtom<Terminal | null> => {
  let atom = tabXTermAtomCache.get(tabId);
  if (!atom) {
    atom = computed($codeTabXTerms, (all) => all[tabId] ?? null);
    tabXTermAtomCache.set(tabId, atom);
  }
  return atom;
};

const CONTENT_READY_TIMEOUT_MS = 10_000;

const fadeVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

const PHASE_LABELS: Partial<Record<AutoLaunchPhase, string>> = {
  checking: 'Checking runtime',
  installing: 'Installing runtime',
  ready: 'Preparing workspace',
  starting: 'Starting services',
  running: 'Loading interface',
};

const PHASE_ORDER: AutoLaunchPhase[] = ['checking', 'installing', 'ready', 'starting', 'running'];

const CodeProgressView = memo(({ tabId }: { tabId: CodeTabId }) => {
  const allPhases = useStore($codeTabPhases);
  const phase = allPhases[tabId] ?? 'checking';
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  const $tabXTerm = useMemo(() => getTabXTermAtom(tabId), [tabId]);
  const sandboxXTerm = useStore($tabXTerm);
  const [showLogs, setShowLogs] = useState(false);

  const label = PHASE_LABELS[phase] ?? 'Starting';
  const hasLogs = phase === 'installing' ? Boolean(omniInstallXTerm) : Boolean(sandboxXTerm);

  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => !prev);
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

          {hasLogs && (
            <Button size="sm" variant="ghost" onClick={toggleLogs}>
              {showLogs ? 'Hide details' : 'Show details'}
            </Button>
          )}

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
                  <XTermLogViewer $xterm={$tabXTerm} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
CodeProgressView.displayName = 'CodeProgressView';

const CodeErrorView = memo(({ tabId }: { tabId: CodeTabId }) => {
  const allErrors = useStore($codeTabErrors);
  const error = allErrors[tabId] ?? null;
  const { retry } = useCodeAutoLaunch(tabId, null);

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

          <Button onClick={retry}>Retry</Button>
        </motion.div>
      </BodyContent>
    </BodyContainer>
  );
});
CodeErrorView.displayName = 'CodeErrorView';

const CodeRunningView = memo(
  ({
    sandboxUrls,
    onReady,
  }: {
    sandboxUrls: { uiUrl: string; codeServerUrl?: string; noVncUrl?: string };
    onReady: () => void;
  }) => {
    const store = useStore(persistedStoreApi.$atom);
    const theme = store.theme ?? 'tokyo-night';

    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl, window.location.origin);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme]);
    const codeServerSrc = sandboxUrls.codeServerUrl;
    const vncSrc = sandboxUrls.noVncUrl;

    const [vncOverlayOpen, setVncOverlayOpen] = useState(false);

    const handleOpenVncOverlay = useCallback(() => {
      setVncOverlayOpen(true);
    }, []);

    const handleCloseVncOverlay = useCallback(() => {
      setVncOverlayOpen(false);
    }, []);

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <CodeSplitLayout uiSrc={uiSrc} codeServerSrc={codeServerSrc} onReady={onReady} />
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
    );
  }
);
CodeRunningView.displayName = 'CodeRunningView';

type CodeTabContentProps = {
  tab: CodeTab;
  isActive: boolean;
};

export const CodeTabContent = memo(({ tab, isActive }: CodeTabContentProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(
    () => store.fleetProjects.find((p) => p.id === tab.projectId) ?? null,
    [store.fleetProjects, tab.projectId]
  );
  const workspaceDir = project?.workspaceDir ?? null;

  const { phase } = useCodeAutoLaunch(tab.id, workspaceDir);

  const allStatuses = useStore($codeTabStatuses);
  const sandboxStatus = allStatuses[tab.id];

  const sandboxUrls = useMemo(() => {
    if (!sandboxStatus || sandboxStatus.type !== 'running') {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  const [contentReady, setContentReady] = useState(false);

  useEffect(() => {
    if (!sandboxUrls) {
      setContentReady(false);
    }
  }, [sandboxUrls]);

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

  if (!tab.projectId) {
    return (
      <div className={cn('w-full h-full', !isActive && 'hidden')}>
        <CodeEmptyState tabId={tab.id} />
      </div>
    );
  }

  return (
    <div className={cn('w-full h-full relative', !isActive && 'hidden')}>
      {sandboxUrls && <CodeRunningView sandboxUrls={sandboxUrls} onReady={handleContentReady} />}

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
            <CodeErrorView tabId={tab.id} />
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
            <CodeEmptyState tabId={tab.id} />
          </motion.div>
        )}
        {!contentReady && phase !== 'error' && phase !== 'idle' && sandboxUrls === null && (
          <motion.div
            key="progress"
            variants={fadeVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="absolute inset-0 z-40 bg-surface"
          >
            <CodeProgressView tabId={tab.id} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
CodeTabContent.displayName = 'CodeTabContent';
