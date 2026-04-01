import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo } from 'react';

import { buildInteractiveVariables, buildTicketInteractiveVariables } from '@/lib/client-tools';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { SessionStartupShell } from '@/renderer/common/SessionStartupShell';
import { Button, cn } from '@/renderer/ds';
import { buildClientToolHandler, buildTicketToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { persistedStoreApi } from '@/renderer/services/store';
import { buildSandboxLabel, isCustomSandbox } from '@/renderer/omniagents-ui/sandbox-label';
import type { CodeTab, CodeTabId, TicketId } from '@/shared/types';

import { CodeEmptyState } from './CodeEmptyState';
import { CodeWorkspaceLayout } from './CodeWorkspaceLayout';
import { $codeTabErrors, $codeTabStatuses, codeApi } from './state';
import { useCodeAutoLaunch } from './use-code-auto-launch';

const CodeErrorView = memo(({ tabId, retry }: { tabId: CodeTabId; retry: () => void }) => {
  const allErrors = useStore($codeTabErrors);
  const error = allErrors[tabId] ?? null;

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
    sessionId,
    onSessionChange,
    variables,
    overlayPane,
    onCloseOverlay,
    onReady,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    sandboxLabel,
    onClientToolCall,
  }: {
    sandboxUrls: { uiUrl: string; codeServerUrl?: string; noVncUrl?: string };
    sessionId?: string;
    onSessionChange?: (sessionId: string | undefined) => void;
    variables?: Record<string, unknown>;
    overlayPane: 'none' | 'code' | 'vnc';
    onCloseOverlay: () => void;
    onReady: () => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    sandboxLabel?: string;
    onClientToolCall?: ClientToolCallHandler;
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
            sessionId={sessionId}
            onSessionChange={onSessionChange}
            variables={variables}
            codeServerSrc={codeServerSrc}
            vncSrc={vncSrc}
            overlayPane={overlayPane}
            onCloseOverlay={onCloseOverlay}
            onReady={onReady}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            sandboxLabel={sandboxLabel}
            onClientToolCall={onClientToolCall}
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

export const CodeTabContent = memo(
  ({ tab, isVisible, overlayPane = 'none', onCloseOverlay, uiMinimal, headerActionsTargetId, headerActionsCompact }: CodeTabContentProps) => {
    const store = useStore(persistedStoreApi.$atom);
    const project = useMemo(
      () => store.projects.find((p) => p.id === tab.projectId) ?? null,
      [store.projects, tab.projectId]
    );
    const workspaceDir = tab.workspaceDir ?? project?.workspaceDir ?? null;
    const sandboxLabel = useMemo(
      () => (store.sandboxEnabled ? buildSandboxLabel(store.sandboxVariant, { custom: isCustomSandbox(project?.sandbox) }) : undefined),
      [store.sandboxEnabled, store.sandboxVariant, project?.sandbox]
    );

    const { phase, retry } = useCodeAutoLaunch(tab.id, workspaceDir);

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

    const handleSessionChange = useCallback(
      (sessionId: string | undefined) => {
        codeApi.setTabSessionId(tab.id, sessionId);
      },
      [tab.id]
    );

    const handleClientToolCall = useMemo(() => {
      if (tab.ticketId && tab.projectId) {
        return buildTicketToolHandler(tab.ticketId as TicketId, tab.projectId);
      }
      return buildClientToolHandler();
    }, [tab.ticketId, tab.projectId]);

    const clientToolVariables = useMemo(
      () =>
        tab.ticketId
          ? buildTicketInteractiveVariables(
              project ? { projectId: project.id, projectLabel: project.label } : undefined
            )
          : buildInteractiveVariables(
              project ? { projectId: project.id, projectLabel: project.label } : undefined
            ),
      [tab.ticketId, project]
    );

    // No project selected — show project picker
    if (!tab.projectId) {
      return (
        <div className={cn('w-full h-full', !isVisible && 'hidden')}>
          <SessionStartupShell
            eyebrow="Workspace Setup"
            title="Choose a project"
            description="Open an existing project in this session or create a new one to start working."
          >
            <CodeEmptyState tabId={tab.id} embedded />
          </SessionStartupShell>
        </div>
      );
    }

    return (
      <div className={cn('w-full h-full relative', !isVisible && 'hidden')}>
        {sandboxUrls ? (
          <CodeRunningView
            sandboxUrls={sandboxUrls}
            sessionId={tab.sessionId}
            onSessionChange={handleSessionChange}
            variables={clientToolVariables}
            overlayPane={overlayPane}
            onCloseOverlay={handleCloseOverlay}
            onReady={() => {}}
            uiMinimal={uiMinimal}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            sandboxLabel={sandboxLabel}
            onClientToolCall={handleClientToolCall}
          />
        ) : phase === 'error' ? (
          <CodeErrorView tabId={tab.id} retry={retry} />
        ) : phase === 'idle' ? (
          <SessionStartupShell
            eyebrow="Workspace Setup"
            title="Choose a project"
            description="Open an existing project in this session or create a new one to start working."
          >
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
              <svg
                className="animate-spin h-4 w-4 text-fg-subtle"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-sm text-fg-muted">Connecting…</span>
            </motion.div>
          </div>
        )}
      </div>
    );
  }
);
CodeTabContent.displayName = 'CodeTabContent';
