import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo } from 'react';

import { buildCodeVariables } from '@/lib/client-tools';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { SessionStartupShell } from '@/renderer/common/SessionStartupShell';
import { Button } from '@/renderer/ds';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { $pendingPlan, resolvePlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { persistedStoreApi } from '@/renderer/services/store';
import { buildSandboxLabel, isCustomSandbox } from '@/renderer/omniagents-ui/sandbox-label';
import type { CodeTab, CodeTabId, TicketId } from '@/shared/types';

import { CodeEmptyState } from './CodeEmptyState';
import { CodeWorkspaceLayout } from './CodeWorkspaceLayout';
import type { DockPane } from './EnvironmentDock';
import { $codeTabErrors, $codeTabStatuses, codeApi } from './state';
import { useCodeAutoLaunch } from './use-code-auto-launch';

const useStyles = makeStyles({
  fullSize: { width: '100%', height: '100%' },
  fullSizeRelative: { width: '100%', height: '100%', position: 'relative' },
  hidden: { display: 'none' },
  flexCenter: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  errorWrap: { maxWidth: '448px', textAlign: 'center', paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL },
  errorText: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightMedium, color: tokens.colorNeutralForeground1 },
  errorRetry: { marginTop: tokens.spacingVerticalL },
  flexColFullRelative: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative' },
  flex1Relative: { flex: '1 1 0', minHeight: 0, position: 'relative' },
  spinnerPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    borderRadius: '9999px',
    backgroundColor: tokens.colorNeutralBackground2,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  spinnerText: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
});

const CodeErrorView = memo(({ tabId, retry }: { tabId: CodeTabId; retry: () => void }) => {
  const styles = useStyles();
  const allErrors = useStore($codeTabErrors);
  const error = allErrors[tabId] ?? null;

  return (
    <div className={styles.flexCenter}>
      <div className={styles.errorWrap}>
        <div className={styles.errorText}>{error ?? 'Something went wrong'}</div>
        <div className={styles.errorRetry}>
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
    onOpenOverlay,
    onReady,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    sandboxLabel,
    onClientToolCall,
    previewUrl,
    onPreviewUrlChange,
    dockTargetId,
    isGlass,
  }: {
    sandboxUrls: { uiUrl: string; codeServerUrl?: string; noVncUrl?: string };
    sessionId?: string;
    onSessionChange?: (sessionId: string | undefined) => void;
    variables?: Record<string, unknown>;
    overlayPane: DockPane;
    onCloseOverlay: () => void;
    onOpenOverlay?: (pane: Exclude<DockPane, 'none'>) => void;
    onReady: () => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    sandboxLabel?: string;
    onClientToolCall?: ClientToolCallHandler;
    previewUrl?: string;
    onPreviewUrlChange?: (url: string) => void;
    dockTargetId?: string;
    isGlass?: boolean;
  }) => {
    const styles = useStyles();
    const store = useStore(persistedStoreApi.$atom);
    const theme = store.theme ?? 'teams-light';
    const pendingPlan = useStore($pendingPlan);

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
      <div className={styles.flexColFullRelative}>
        <div className={styles.flex1Relative}>
          <CodeWorkspaceLayout
            uiSrc={uiSrc}
            sessionId={sessionId}
            onSessionChange={onSessionChange}
            variables={variables}
            codeServerSrc={codeServerSrc}
            vncSrc={vncSrc}
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
            overlayPane={overlayPane}
            onCloseOverlay={onCloseOverlay}
            onOpenOverlay={onOpenOverlay}
            onReady={onReady}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            sandboxLabel={sandboxLabel}
            onClientToolCall={onClientToolCall}
            pendingPlan={pendingPlan}
            onPlanDecision={resolvePlanApproval}
            dockTargetId={dockTargetId}
            isGlass={isGlass}
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
  overlayPane?: DockPane;
  onCloseOverlay?: () => void;
  onOpenOverlay?: (pane: Exclude<DockPane, 'none'>) => void;
  uiMinimal?: boolean;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  dockTargetId?: string;
  isGlass?: boolean;
};

export const CodeTabContent = memo(
  ({ tab, isVisible, overlayPane = 'none', onCloseOverlay, onOpenOverlay, uiMinimal, headerActionsTargetId, headerActionsCompact, previewUrl, onPreviewUrlChange, dockTargetId, isGlass }: CodeTabContentProps) => {
    const styles = useStyles();
    const store = useStore(persistedStoreApi.$atom);
    const project = useMemo(
      () => store.projects.find((p) => p.id === tab.projectId) ?? null,
      [store.projects, tab.projectId]
    );
    const workspaceDir = tab.workspaceDir ?? (project?.source?.kind === 'local' ? project.source.workspaceDir : null) ?? null;
    const sandboxBackend = store.sandboxBackend ?? 'none';
    const sandboxLabel = useMemo(
      () => (sandboxBackend !== 'none' ? buildSandboxLabel(sandboxBackend, { custom: isCustomSandbox(project?.sandbox) }) : undefined),
      [sandboxBackend, project?.sandbox]
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

    const handleClientToolCall = useMemo(
      () =>
        buildClientToolHandler({
          ...(tab.ticketId && tab.projectId
            ? { ticketId: tab.ticketId as TicketId, projectId: tab.projectId }
            : {}),
          tabId: tab.id,
        }),
      [tab.id, tab.ticketId, tab.projectId]
    );

    const clientToolVariables = useMemo(
      () =>
        buildCodeVariables({
          ...(project ? { projectId: project.id, projectLabel: project.label } : {}),
          ...(tab.ticketId ? { ticketId: tab.ticketId } : {}),
        }),
      [tab.ticketId, project]
    );

    // No project selected — show project picker
    if (!tab.projectId) {
      return (
        <div className={mergeClasses(styles.fullSize, !isVisible && styles.hidden)}>
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
      <div className={mergeClasses(styles.fullSizeRelative, !isVisible && styles.hidden)}>
        {sandboxUrls ? (
          <CodeRunningView
            sandboxUrls={sandboxUrls}
            sessionId={tab.sessionId}
            onSessionChange={handleSessionChange}
            variables={clientToolVariables}
            overlayPane={overlayPane}
            onCloseOverlay={handleCloseOverlay}
            onOpenOverlay={onOpenOverlay}
            onReady={() => {}}
            uiMinimal={uiMinimal}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            sandboxLabel={sandboxLabel}
            onClientToolCall={handleClientToolCall}
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
            dockTargetId={dockTargetId}
            isGlass={isGlass}
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
          <div className={styles.flexCenter}>
            <motion.div
              className={styles.spinnerPill}
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
              <span className={styles.spinnerText}>Connecting…</span>
            </motion.div>
          </div>
        )}
      </div>
    );
  }
);
CodeTabContent.displayName = 'CodeTabContent';
