import { useStore } from '@nanostores/react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { dispatchOpenFileIntent, WorkspaceFilesPortal } from '@/renderer/features/Files';
import { WorkspaceGitPortal } from '@/renderer/features/Git';
import { usePortalTarget } from '@/renderer/hooks/use-portal-target';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import type { PendingMessage } from '@/renderer/omniagents-ui/ChatShell';
import {
  emitColumnRunEnd,
  emitColumnRunStarted,
  registerSessionController,
  type SessionController,
} from '@/renderer/services/session-control';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AppId } from '@/shared/app-registry';
import { buildAppRegistry } from '@/shared/app-registry';
import type { AgentRuntimeConnection, ExecutionTarget, TicketId } from '@/shared/types';

import { EnvironmentDock } from './EnvironmentDock';
import { codeApi } from './state';

type CodeWorkspaceLayoutProps = {
  connection: AgentRuntimeConnection;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  voiceVariables?: Record<string, unknown>;
  codeServerSrc?: string;
  vncSrc?: string;
  activeApp?: AppId;
  onActiveAppChange?: (app: AppId) => void;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  sandboxLabel?: string;
  sandboxOptions?: { value: string; label: string }[];
  currentSandboxProfile?: string;
  onSandboxChange?: (value: string) => void;
  composerExtras?: ReactNode;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  dockTargetId?: string;
  /** Chat mode: time-of-day greeting shown on the empty conversation. */
  greeting?: string;
  /** One-tap example tasks shown on the empty conversation. */
  suggestions?: ReadonlyArray<{ label: string; prompt: string }>;
  /** Messages queued pre-launch; the app flushes them once its RPC connects. */
  pendingMessages?: PendingMessage[];
  /** Releases the launch-owned preview once the embedded chat claims it. */
  onPendingMessagesFlushed?: () => void;
  /**
   * When provided, this layout hosts a column-scoped workspace and all its
   * webviews register under `tab-<tabId>:*`. Omit for the global dock.
   */
  tabId?: string;
  /**
   * What the in-sandbox agent should treat as its workspace root.
   * For host profiles this is the host path; for containerized
   * profiles it's the in-container path (``/workspace/<mountName>``).
   * Plumbed to ``OmniAgentsApp.workspaceDir`` so
   * ``session.variables.workspace_root`` is valid inside whatever
   * environment the agent's tools execute in.
   *
   * Terminals do NOT use this — they route through `omni serve`'s
   * `SessionPtyBackend` and land at the sandbox profile's
   * `terminal.cwd`. The renderer has no business choosing a terminal
   * cwd.
   */
  agentWorkspaceDir?: string;
  /** Stable portal host for the Files surface owned by this session column. */
  filesHost: HTMLDivElement;
  /** Stable portal host for the Git surface owned by this session column. */
  gitHost: HTMLDivElement;
  /** Execution environment whose workspace the Files and Git RPC surfaces address. */
  executionTarget?: ExecutionTarget;
  /** Ticket bound to this column — enables the supervisor bridge actor. */
  ticketId?: TicketId;
  /** Routine bound to this column — enables the routine bridge actor. */
  routineId?: string;
};

export const CodeWorkspaceLayout = memo(
  ({
    connection,
    sessionId,
    onSessionChange,
    variables,
    voiceVariables,
    codeServerSrc,
    vncSrc,
    activeApp = 'chat',
    onActiveAppChange,
    onReady,
    headerActionsTargetId,
    headerActionsCompact,
    sandboxLabel,
    sandboxOptions,
    currentSandboxProfile,
    onSandboxChange,
    composerExtras,
    onClientToolCall,
    pendingPlan,
    onPlanDecision,
    dockTargetId,
    greeting,
    suggestions,
    pendingMessages,
    onPendingMessagesFlushed,
    tabId,
    agentWorkspaceDir,
    filesHost,
    gitHost,
    executionTarget,
    ticketId,
    routineId,
  }: CodeWorkspaceLayoutProps) => {
    const store = useStore(persistedStoreApi.$atom);
    const registry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);
    // The dock only surfaces apps marked column-scoped. Global-only custom
    // apps are opened via the app launcher as their own deck column instead.
    const dockApps = useMemo(() => registry.filter((app) => app.columnScoped && app.id !== 'chat'), [registry]);

    // Register this column's agent controller (by tabId) so the global
    // orchestrator can drive it via the `column_*` tools. The App hands the
    // controller up through `onController`; we (re)register on each change and
    // unregister on unmount.
    const unregisterControllerRef = useRef<(() => void) | null>(null);
    const handleController = useCallback(
      (controller: SessionController | null) => {
        unregisterControllerRef.current?.();
        unregisterControllerRef.current = controller && tabId ? registerSessionController(tabId, controller) : null;
      },
      [tabId]
    );
    useEffect(
      () => () => {
        unregisterControllerRef.current?.();
        unregisterControllerRef.current = null;
      },
      []
    );
    const handleRunEnd = useCallback(
      (info: { runId?: string; reason?: string }) => {
        if (tabId) {
          emitColumnRunEnd(tabId, info);
        }
      },
      [tabId]
    );
    const handleRunStarted = useCallback(
      (runId: string) => {
        if (tabId) {
          emitColumnRunStarted(tabId, runId);
        }
      },
      [tabId]
    );

    const sandboxUrls = useMemo(() => ({ codeServerUrl: codeServerSrc, noVncUrl: vncSrc }), [codeServerSrc, vncSrc]);

    const dockTarget = usePortalTarget(dockTargetId);
    const [filesActivated, setFilesActivated] = useState(activeApp === 'files');
    const [gitActivated, setGitActivated] = useState(activeApp === 'git');
    useEffect(() => {
      if (activeApp === 'files') {
        setFilesActivated(true);
      }
      if (activeApp === 'git') {
        setGitActivated(true);
      }
    }, [activeApp]);
    const handleGitOpenFile = useCallback(
      (path: string, line?: number) => {
        if (!sessionId) {
          return;
        }
        onActiveAppChange?.('files');
        void dispatchOpenFileIntent(
          {
            sessionId,
            path,
            location: line === undefined ? undefined : { line },
            source: 'git-diff',
          },
          { waitForTargetMs: 1_500 }
        );
      },
      [onActiveAppChange, sessionId]
    );
    const handleUiReady = useCallback(() => {
      onReady?.();
    }, [onReady]);

    const handleDockSelect = useCallback(
      (id: AppId) => {
        onActiveAppChange?.(id);
      },
      [onActiveAppChange]
    );

    // In-chat entry points (e.g. the Agents pill) open (not toggle) a
    // sidecar app — same path as the `launch_app` client tool.
    const handleOpenApp = useCallback(
      (appId: string) => {
        if (tabId) {
          void codeApi.openSidecarApp(tabId, appId);
        }
      },
      [tabId]
    );

    return (
      <div className="relative flex h-full w-full flex-col bg-card">
        <div className="relative min-h-0 flex-1">
          <div className="h-full w-full min-w-0">
            <OmniAgentsApp
              connection={connection}
              executionTarget={executionTarget}
              greeting={greeting}
              suggestions={suggestions}
              pendingMessages={pendingMessages}
              onPendingMessagesFlushed={onPendingMessagesFlushed}
              sessionId={sessionId}
              onSessionChange={onSessionChange}
              variables={variables}
              voiceVariables={voiceVariables}
              onReady={handleUiReady}
              headerActionsTargetId={headerActionsTargetId}
              headerActionsCompact={headerActionsCompact}
              sandboxLabel={sandboxLabel}
              sandboxOptions={sandboxOptions}
              currentSandboxProfile={currentSandboxProfile}
              onSandboxChange={onSandboxChange}
              composerExtras={composerExtras}
              onClientToolCall={onClientToolCall}
              onController={handleController}
              onRunEnd={handleRunEnd}
              onRunStarted={handleRunStarted}
              pendingPlan={pendingPlan}
              onPlanDecision={onPlanDecision}
              ticketId={ticketId}
              routineId={routineId}
              workspaceDir={agentWorkspaceDir}
              onOpenApp={tabId ? handleOpenApp : undefined}
              providerChildren={
                executionTarget && (filesActivated || gitActivated) ? (
                  <>
                    {filesActivated && (
                      <WorkspaceFilesPortal
                        host={filesHost}
                        executionTarget={executionTarget}
                        sessionId={sessionId}
                        workspaceRoot={agentWorkspaceDir}
                      />
                    )}
                    {gitActivated && (
                      <WorkspaceGitPortal
                        host={gitHost}
                        active={activeApp === 'git'}
                        tabId={tabId}
                        executionTarget={executionTarget}
                        sessionId={sessionId}
                        workspaceRoot={agentWorkspaceDir}
                        onOpenFile={handleGitOpenFile}
                      />
                    )}
                  </>
                ) : undefined
              }
            />
          </div>
        </div>
        {(() => {
          const dock = (
            <EnvironmentDock
              apps={dockApps}
              activeAppId={activeApp}
              onSelect={handleDockSelect}
              sandboxUrls={sandboxUrls}
            />
          );
          if (dockTargetId && dockTarget) {
            return createPortal(dock, dockTarget);
          }
          return dock;
        })()}
      </div>
    );
  }
);
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
