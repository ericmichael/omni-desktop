import { useStore } from '@nanostores/react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { dispatchOpenFileIntent, WorkspaceFilesPortal } from '@/renderer/features/Files';
import { WorkspaceGitPortal } from '@/renderer/features/Git';
import { WorkspaceReviewPortal } from '@/renderer/features/Review';
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
import type { AgentRuntimeConnection, ExecutionTarget, TicketId, WorkspaceMountDescriptor } from '@/shared/types';

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
  /**
   * Capability names of the attached execution environment. Gates
   * capability-dependent dock apps: Terminal hides when `pty` is absent
   * (wasm sandboxes run commands to completion — nothing to attach a
   * shell to). Undefined = unknown environment; everything stays visible.
   */
  environmentCapabilities?: string[];
  composerExtras?: ReactNode;
  onClientToolCall?: ClientToolCallHandler;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
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
  /**
   * Single-mount scope for the workspace sidecar surfaces: when the
   * environment root wraps exactly one mount (chat scratch sessions,
   * one-source projects), Files/Git/Review root themselves inside it so
   * paths don't carry the redundant `<mountName>/` wrapper.
   */
  workspaceRootPrefix?: string;
  /** Authoritative mount table for the environment (labels multi-mount roots). */
  workspaceMounts?: WorkspaceMountDescriptor[];
  /** Stable portal host for the Files surface owned by this session column. */
  filesHost: HTMLDivElement;
  /** Stable portal host for the Git surface owned by this session column. */
  gitHost: HTMLDivElement;
  /** Stable portal host for the Review surface owned by this session column. */
  reviewHost: HTMLDivElement;
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
    environmentCapabilities,
    composerExtras,
    onClientToolCall,
    pendingPlan,
    onPlanDecision,
    greeting,
    suggestions,
    pendingMessages,
    onPendingMessagesFlushed,
    tabId,
    agentWorkspaceDir,
    workspaceRootPrefix,
    workspaceMounts,
    filesHost,
    gitHost,
    reviewHost,
    executionTarget,
    ticketId,
    routineId,
  }: CodeWorkspaceLayoutProps) => {
    const store = useStore(persistedStoreApi.$atom);
    const registry = useMemo(() => buildAppRegistry(store.customApps ?? []), [store.customApps]);
    // The dock only surfaces apps marked column-scoped. Global-only custom
    // apps are opened via the app launcher as their own deck column instead.
    // Capability-dependent apps additionally require the attached
    // environment to affirmatively support them: Terminal appears only
    // once the environment reports the `pty` capability — no environment
    // yet means no shell to offer, and wasm sandboxes never grow one
    // (terminal.create would only return a typed refusal).
    const dockApps = useMemo(
      () =>
        registry.filter((app) => {
          if (!app.columnScoped || app.id === 'chat') {
            return false;
          }
          if (app.id === 'terminal' && !environmentCapabilities?.includes('pty')) {
            return false;
          }
          return true;
        }),
      [registry, environmentCapabilities]
    );
    // If Terminal was already open when its capability disappeared (column
    // relaunched, profile switched to a wasm sandbox), bounce back to chat
    // instead of stranding the user on a panel whose dock icon vanished.
    useEffect(() => {
      if (activeApp === 'terminal' && !environmentCapabilities?.includes('pty')) {
        onActiveAppChange?.('chat');
      }
    }, [activeApp, environmentCapabilities, onActiveAppChange]);

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

    const [filesActivated, setFilesActivated] = useState(activeApp === 'files');
    const [gitActivated, setGitActivated] = useState(activeApp === 'git');
    const [reviewActivated, setReviewActivated] = useState(activeApp === 'review');
    useEffect(() => {
      if (activeApp === 'files') {
        setFilesActivated(true);
      }
      if (activeApp === 'git') {
        setGitActivated(true);
      }
      if (activeApp === 'review') {
        setReviewActivated(true);
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
                executionTarget && (filesActivated || gitActivated || reviewActivated) ? (
                  <>
                    {filesActivated && (
                      <WorkspaceFilesPortal
                        host={filesHost}
                        executionTarget={executionTarget}
                        sessionId={sessionId}
                        workspaceRoot={agentWorkspaceDir}
                        rootPrefix={workspaceRootPrefix}
                        mounts={workspaceMounts}
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
                        rootPrefix={workspaceRootPrefix}
                        onOpenFile={handleGitOpenFile}
                      />
                    )}
                    {reviewActivated && (
                      <WorkspaceReviewPortal
                        host={reviewHost}
                        active={activeApp === 'review'}
                        executionTarget={executionTarget}
                        sessionId={sessionId}
                        workspaceRoot={agentWorkspaceDir}
                        rootPrefix={workspaceRootPrefix}
                        onOpenFile={handleGitOpenFile}
                      />
                    )}
                  </>
                ) : undefined
              }
            />
          </div>
        </div>
        <EnvironmentDock
          apps={dockApps}
          activeAppId={activeApp}
          onSelect={handleDockSelect}
          sandboxUrls={sandboxUrls}
        />
      </div>
    );
  }
);
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
