import { useStore } from '@nanostores/react';
import type { Terminal } from '@xterm/xterm';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReadableAtom } from 'nanostores';
import { computed } from 'nanostores';
import { memo, useCallback, useMemo } from 'react';

import { SessionStartupShell } from '@/renderer/common/SessionStartupShell';
import { Button, cn } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, CodeTabId } from '@/shared/types';

import { CodeEmptyState } from './CodeEmptyState';
import { CodeWorkspaceLayout } from './CodeWorkspaceLayout';
import { $codeTabErrors, $codeTabStatuses, $codeTabXTerms } from './state';
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

const CodeErrorView = memo(({ tabId }: { tabId: CodeTabId }) => {
  const allErrors = useStore($codeTabErrors);
  const error = allErrors[tabId] ?? null;
  const { retry } = useCodeAutoLaunch(tabId, null);

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="max-w-md text-center px-4">
        <div className="text-lg font-medium text-fg">{error ?? 'Something went wrong'}</div>
        <div className="mt-4">
          <Button onClick={retry}>Retry</Button>
        </div>
      </div>
    </div>
  );
});
CodeErrorView.displayName = 'CodeErrorView';

const CodeRunningView = memo(
  ({
    sandboxUrls,
    overlayPane,
    onCloseOverlay,
    onReady,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
  }: {
    sandboxUrls: { uiUrl: string; codeServerUrl?: string; noVncUrl?: string };
    overlayPane: 'none' | 'code' | 'vnc';
    onCloseOverlay: () => void;
    onReady: () => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
  }) => {
    const store = useStore(persistedStoreApi.$atom);
    const theme = store.theme ?? 'tokyo-night';

    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl, window.location.origin);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      if (uiMinimal) {
        url.searchParams.set('minimal', 'true');
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme, uiMinimal]);
    const codeServerSrc = sandboxUrls.codeServerUrl;
    const vncSrc = sandboxUrls.noVncUrl;

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <CodeWorkspaceLayout
            uiSrc={uiSrc}
            codeServerSrc={codeServerSrc}
            vncSrc={vncSrc}
            overlayPane={overlayPane}
            onCloseOverlay={onCloseOverlay}
            onReady={onReady}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
          />
        </div>
      </div>
    );
  }
);
CodeRunningView.displayName = 'CodeRunningView';

type CodeTabContentProps = {
  tab: CodeTab;
  isVisible: boolean;
  overlayPane?: 'none' | 'code' | 'vnc';
  onCloseOverlay?: () => void;
  uiMinimal?: boolean;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
};

export const CodeTabContent = memo(({ tab, isVisible, overlayPane = 'none', onCloseOverlay, uiMinimal, headerActionsTargetId, headerActionsCompact }: CodeTabContentProps) => {
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
    if (!sandboxStatus || (sandboxStatus.type !== 'running' && sandboxStatus.type !== 'connecting')) {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  const handleCloseOverlay = useCallback(() => {
    onCloseOverlay?.();
  }, [onCloseOverlay]);

  // No project selected — show project picker
  if (!tab.projectId) {
    return (
      <div className={cn('w-full h-full', !isVisible && 'hidden')}>
        <SessionStartupShell eyebrow="Workspace Setup" title="Choose a project" description="Open an existing project in this session or create a new one to start working.">
          <CodeEmptyState tabId={tab.id} embedded />
        </SessionStartupShell>
      </div>
    );
  }

  const isConnecting = !sandboxUrls && phase !== 'error' && phase !== 'idle';

  return (
    <div className={cn('w-full h-full relative', !isVisible && 'hidden')}>
      {sandboxUrls ? (
        <CodeRunningView
          sandboxUrls={sandboxUrls}
          overlayPane={overlayPane}
          onCloseOverlay={handleCloseOverlay}
          onReady={() => {}}
          uiMinimal={uiMinimal}
          headerActionsTargetId={headerActionsTargetId}
          headerActionsCompact={headerActionsCompact}
        />
      ) : phase === 'error' ? (
        <CodeErrorView tabId={tab.id} />
      ) : phase === 'idle' ? (
        <SessionStartupShell eyebrow="Workspace Setup" title="Choose a project" description="Open an existing project in this session or create a new one to start working.">
          <CodeEmptyState tabId={tab.id} embedded />
        </SessionStartupShell>
      ) : (
        /* Connecting — show a subtle centered indicator */
        <div className="w-full h-full flex items-center justify-center">
          <motion.div
            className="inline-flex items-center gap-2 rounded-full bg-surface-raised px-4 py-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <svg className="animate-spin h-4 w-4 text-fg-subtle" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm text-fg-muted">Connecting…</span>
          </motion.div>
        </div>
      )}
    </div>
  );
});
CodeTabContent.displayName = 'CodeTabContent';
