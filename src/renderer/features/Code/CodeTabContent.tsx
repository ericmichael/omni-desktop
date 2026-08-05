import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { getArtifactsDir, getContainerArtifactsDir, profileRunsOnHost } from '@/lib/artifacts';
import { conversationTitle } from '@/lib/chat-conversations';
import { buildSessionVariables } from '@/lib/client-tools';
import { uuidv4 } from '@/lib/uuid';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { SessionStatusBanner } from '@/renderer/features/Banner/SessionStatusBanner';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { openSettingsTab } from '@/renderer/features/SettingsModal/settings-nav';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { $pendingPlan, resolvePlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { useSandboxActivityPing } from '@/renderer/hooks/use-sandbox-activity-ping';
import { useSessionWorkspaceDir } from '@/renderer/hooks/use-session-workspace-dir';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { ChatShell, type PendingMessage } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { buildProfileLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { configApi } from '@/renderer/services/config';
import { emitter, serverOrigin } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { $hoveredVoiceScope, VoiceScopeContext } from '@/renderer/services/voice-recording';
import type { AppId } from '@/shared/app-registry';
import type { CodeTab, CodeTabId, TicketId } from '@/shared/types';
import { firstSource, isChatColumn } from '@/shared/types';
import { getActivePersona } from '@/shared/voice-personas';

import { AttachProjectMenu } from './AttachProjectMenu';
import { CodeWorkspaceLayout } from './CodeWorkspaceLayout';
import { CHAT_SUGGESTIONS, COLUMN_SUGGESTIONS } from './empty-suggestions';
import { $codeTabErrors, $codeTabStatuses, codeApi } from './state';
import { useCodeAutoLaunch } from './use-code-auto-launch';

const CodeErrorView = memo(({ tabId, retry }: { tabId: CodeTabId; retry: () => void }) => {
  const allErrors = useStore($codeTabErrors);
  const error = allErrors[tabId] ?? null;

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="max-w-112 text-center pl-5 pr-5">
        <div className="text-base font-medium text-foreground">{error ?? 'Something went wrong'}</div>
        <div className="mt-5">
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
    environmentId,
    sessionId,
    onSessionChange,
    variables,
    voiceVariables,
    activeApp,
    onActiveAppChange,
    onReady,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    sandboxLabel,
    sandboxOptions,
    currentSandboxProfile,
    onSandboxChange,
    onClientToolCall,
    dockTargetId,
    tabId,
    agentWorkspaceDir,
    filesHost,
    gitHost,
    ticketId,
    routineId,
    switching,
    greeting,
    suggestions,
    pendingMessages,
    onPendingMessagesFlushed,
  }: {
    sandboxUrls: { uiUrl: string; authToken?: string; services?: Record<string, string> };
    environmentId?: string;
    sessionId?: string;
    onSessionChange?: (sessionId: string | undefined) => void;
    variables?: Record<string, unknown>;
    voiceVariables?: Record<string, unknown>;
    activeApp: AppId;
    onActiveAppChange?: (app: AppId) => void;
    onReady: () => void;
    uiMinimal?: boolean;
    headerActionsTargetId?: string;
    headerActionsCompact?: boolean;
    sandboxLabel?: string;
    sandboxOptions?: { value: string; label: string }[];
    currentSandboxProfile?: string;
    onSandboxChange?: (value: string) => void;
    onClientToolCall?: ClientToolCallHandler;
    dockTargetId?: string;
    tabId?: string;
    agentWorkspaceDir?: string;
    filesHost: HTMLDivElement;
    gitHost: HTMLDivElement;
    ticketId?: TicketId;
    routineId?: string;
    switching?: boolean;
    /** Chat mode: time-of-day greeting shown on the empty conversation. */
    greeting?: string;
    /** One-tap example tasks shown on the empty conversation. */
    suggestions?: ReadonlyArray<{ label: string; prompt: string }>;
    /** Messages queued pre-launch; flushed by the app once its RPC connects. */
    pendingMessages?: PendingMessage[];
    onPendingMessagesFlushed?: () => void;
  }) => {
    const store = useStore(persistedStoreApi.$atom);
    const theme = store.theme ?? 'teams-light';
    const pendingPlan = useStore($pendingPlan);

    const runtimeConnection = useMemo(() => {
      // serverOrigin() returns the cloud baseUrl in cloud-linked Electron;
      // resolving the agent's relative /proxy/... against window.location
      // would (wrongly) anchor to localhost:5173 / file:// in that mode.
      const url = new URL(sandboxUrls.uiUrl, serverOrigin());
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      if (uiMinimal) {
        url.searchParams.set('minimal', 'true');
      }
      return { baseUrl: url.toString(), authToken: sandboxUrls.authToken };
    }, [sandboxUrls.authToken, sandboxUrls.uiUrl, theme, uiMinimal]);
    const codeServerSrc = sandboxUrls.services?.['code_server'];
    const vncSrc = sandboxUrls.services?.['vnc'];

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <CodeWorkspaceLayout
            connection={runtimeConnection}
            environmentId={environmentId}
            sessionId={sessionId}
            onSessionChange={onSessionChange}
            variables={variables}
            voiceVariables={voiceVariables}
            codeServerSrc={codeServerSrc}
            vncSrc={vncSrc}
            activeApp={activeApp}
            onActiveAppChange={onActiveAppChange}
            onReady={onReady}
            headerActionsTargetId={headerActionsTargetId}
            headerActionsCompact={headerActionsCompact}
            sandboxLabel={sandboxLabel}
            sandboxOptions={sandboxOptions}
            currentSandboxProfile={currentSandboxProfile}
            onSandboxChange={onSandboxChange}
            onClientToolCall={onClientToolCall}
            pendingPlan={pendingPlan}
            onPlanDecision={resolvePlanApproval}
            dockTargetId={dockTargetId}
            tabId={tabId}
            agentWorkspaceDir={agentWorkspaceDir}
            filesHost={filesHost}
            gitHost={gitHost}
            ticketId={ticketId}
            routineId={routineId}
            greeting={greeting}
            suggestions={suggestions}
            pendingMessages={pendingMessages}
            onPendingMessagesFlushed={onPendingMessagesFlushed}
          />
        </div>
        {switching && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-card">
            <div className="flex max-w-80 flex-col items-center gap-2 rounded-2xl bg-card px-8 py-6 text-center shadow-xl">
              <Spinner />
              <span className="text-base font-semibold text-foreground">
                Switching to {getProfileMenuLabel(currentSandboxProfile ?? 'host')}…
              </span>
              <span className="text-xs text-muted-foreground">Your conversation and files are preserved.</span>
            </div>
          </div>
        )}
      </div>
    );
  }
);
CodeRunningView.displayName = 'CodeRunningView';

type CodeTabContentProps = {
  tab: CodeTab;
  isVisible: boolean;
  activeApp?: AppId;
  onActiveAppChange?: (app: AppId) => void;
  uiMinimal?: boolean;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  dockTargetId?: string;
  filesHost: HTMLDivElement;
  gitHost: HTMLDivElement;
};

export const CodeTabContent = memo(
  ({
    tab,
    isVisible,
    activeApp = 'chat',
    onActiveAppChange,
    uiMinimal,
    headerActionsTargetId,
    headerActionsCompact,
    dockTargetId,
    filesHost,
    gitHost,
  }: CodeTabContentProps) => {
    const store = useStore(persistedStoreApi.$atom);
    // Chat mode is derived, not reserved: any projectless session column runs
    // as an ambient chat with a per-conversation scratch workspace. Attaching
    // a project converts it in place.
    const chatMode = isChatColumn(tab);
    const project = useMemo(
      () => store.projects.find((p) => p.id === tab.projectId) ?? null,
      [store.projects, tab.projectId]
    );
    // Projects without a linked local source still have a managed directory on
    // disk (`Projects/<slug>/` or `~/Omni/Workspace/` for Personal). Resolve it
    // lazily so the sandbox can start even when the user hasn't picked a
    // workspace.
    const projectSource = firstSource(project);
    const primaryLocalSource = project?.sources.find((source) => source.kind === 'local');
    const linkedWorkspaceDir =
      tab.workspaceDir ?? (projectSource?.kind === 'local' ? projectSource.workspaceDir : null) ?? null;
    const [resolvedProjectDir, setResolvedProjectDir] = useState<string | null>(null);
    useEffect(() => {
      if (linkedWorkspaceDir || !tab.projectId) {
        setResolvedProjectDir(null);
        return;
      }
      let cancelled = false;
      void emitter.invoke('project:get-dir', tab.projectId).then((dir) => {
        if (!cancelled) {
          setResolvedProjectDir(dir);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [tab.projectId, linkedWorkspaceDir]);
    // Chat: mint the conversation id on the record if absent. It keys chat
    // history and the scratch directory, never the Workspace snapshot.
    useEffect(() => {
      if (chatMode && !tab.sessionId) {
        void codeApi.setTabSessionId(tab.id, uuidv4());
      }
    }, [chatMode, tab.sessionId, tab.id]);

    // Older local state predates explicit Workspace snapshot identity. Mint it
    // independently instead of reusing the conversation id.
    useEffect(() => {
      if (!tab.snapshotRef) {
        void codeApi.setTabSnapshotRef(tab.id, uuidv4());
      }
    }, [tab.id, tab.snapshotRef]);

    // Chat is an ambient surface, not a project — each conversation gets an
    // isolated `<workspaceDir>/Sessions/<sessionId>` scratch dir. Switching
    // conversations changes the workspace, which useAutoLaunch's reset effect
    // turns into a sandbox restart. Hook is called unconditionally (null base
    // for non-chat tabs) to keep hook order static.
    //
    // Lazy launch: the base dir is withheld until the column is ACTIVATED
    // (first message sent or migration stamp) — a null workspaceDir keeps
    // useAutoLaunch parked in idle, so creating a chat column costs nothing.
    const chatScratchDir = useSessionWorkspaceDir(
      chatMode && tab.sessionId && tab.activatedAt ? (store.workspaceDir ?? null) : null,
      tab.sessionId ?? ''
    );

    const workspaceDir = chatMode ? chatScratchDir : (linkedWorkspaceDir ?? resolvedProjectDir);
    const sourceOverrideDir =
      tab.workspaceDir && primaryLocalSource?.kind === 'local' && tab.workspaceDir !== primaryLocalSource.workspaceDir
        ? tab.workspaceDir
        : undefined;

    // Sticky profile binding persisted on the tab. The migration backfills
    // existing installs; ``codeApi.addTab*`` seeds new tabs from the same
    // resolution chain (per-project ``sandboxProfile`` → user default) so we
    // don't drift if the user changes defaults later. The picker writes
    // through ``codeApi.setTabProfile`` and the new value flows back via
    // ``useStore``. The ``project?.sandboxProfile`` / ``store.defaultProfileName``
    // fallbacks below only kick in for tabs predating the migration that
    // somehow got loaded without a stored profileName (defensive).
    const profileName = tab.profileName ?? project?.sandboxProfile ?? store.defaultProfileName ?? 'host';
    const handleProfileChange = useCallback(
      (value: string) => {
        void codeApi.setTabProfile(tab.id, value);
      },
      [tab.id]
    );
    const machines = useStore($machines);
    const localVoice = store.localVoiceEnabled && isLocalVoiceCapable();
    const sandboxLabel = useMemo(() => buildProfileLabel(profileName, machines), [profileName, machines]);

    const [isEnterprise, setIsEnterprise] = useState(false);
    useEffect(() => {
      emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
    }, []);
    const sandboxOptions = useMemo(
      () =>
        getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles }).map((name) => ({
          value: name,
          label: getProfileMenuLabel(name, machines),
        })),
      [isEnterprise, store.availableSandboxProfiles, machines]
    );

    const [greeting] = useState(getGreeting);
    const allLaunchErrors = useStore($codeTabErrors);

    // Messages typed before the sandbox is up. The first submit activates the
    // column (which triggers the launch); OmniAgentsApp flushes the queue the
    // moment its RPC connects, so nothing typed during boot is lost.
    const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
    const handlePendingMessagesFlushed = useCallback(() => setPendingMessages([]), []);
    // A conversation switch (new chat / resume) must not leak the previous
    // conversation's queued messages into the new session.
    useEffect(() => {
      setPendingMessages([]);
    }, [tab.sessionId]);
    const handlePrelaunchSubmit = useCallback(
      (msg: PendingMessage) => {
        if (!store.workspaceDir) {
          openSettingsTab('Workspace');
          return;
        }
        setPendingMessages((prev) => [...prev, msg]);
        if (!tab.activatedAt) {
          // First intent: title the conversation and boot the sandbox.
          if (tab.sessionId && msg.text.trim()) {
            void codeApi.recordConversation(tab.sessionId, { title: conversationTitle(msg.text) });
          }
          void codeApi.setTabActivated(tab.id);
        }
      },
      [store.workspaceDir, tab.activatedAt, tab.sessionId, tab.id]
    );

    const { phase, retry } = useCodeAutoLaunch(tab.id, tab.snapshotRef ? workspaceDir : null, {
      ...(tab.projectId ? { projectId: tab.projectId } : {}),
      ...(sourceOverrideDir ? { sourceOverrideDir } : {}),
      profileNameOverride: profileName,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      ...(tab.snapshotRef ? { snapshotRef: tab.snapshotRef } : {}),
    });
    useSandboxActivityPing(tab.id);

    const allStatuses = useStore($codeTabStatuses);
    const sandboxStatus = allStatuses[tab.id];

    // Only mount the iframe on ``running``. ``connecting`` arrives the
    // moment omni-serve emits its JSON readiness line — that's before
    // uvicorn has actually bound the port, so loading the iframe there
    // briefly shows ERR_CONNECTION_REFUSED / a uvicorn error before the
    // real UI loads. ``agent-process.ts`` already gates ``running`` on
    // an HTTP+WS health probe, so by then the port is truly serving.
    const sandboxUrls = useMemo(() => {
      if (!sandboxStatus || sandboxStatus.type !== 'running') {
        return null;
      }
      return sandboxStatus.data;
    }, [sandboxStatus]);
    useEffect(() => {
      if (pendingMessages.length > 0) {
        console.info(
          `[pending-intent] owner tab=${tab.id} session=${tab.sessionId ?? 'none'} count=${pendingMessages.length} runtime=${sandboxUrls ? 'running' : 'waiting'}`
        );
      }
    }, [pendingMessages, sandboxUrls, tab.id, tab.sessionId]);
    const environmentId = sandboxUrls?.environmentId;
    // The provisioned environment owns this value. Renderer guesses were the
    // source of Host/Devbox drift whenever source layouts differed.
    const agentWorkspaceDir = sandboxUrls?.workspaceRoot;

    const handleSessionChange = useCallback(
      (sessionId: string | undefined) => {
        codeApi.setTabSessionId(tab.id, sessionId);
      },
      [tab.id]
    );

    const handleClientToolCall = useMemo(
      () =>
        buildClientToolHandler({
          ...(tab.ticketId && tab.projectId ? { ticketId: tab.ticketId as TicketId, projectId: tab.projectId } : {}),
          tabId: tab.id,
        }),
      [tab.id, tab.ticketId, tab.projectId]
    );

    // Resolve the host omni config dir once — we need it to tell the agent
    // where to write PR artifacts when it runs on the host (no sandbox).
    const [hostConfigDir, setHostConfigDir] = useState<string | null>(null);
    useEffect(() => {
      let cancelled = false;
      void configApi.getOmniConfigDir().then((dir) => {
        if (!cancelled) {
          setHostConfigDir(dir);
        }
      });
      return () => {
        cancelled = true;
      };
    }, []);

    // Look up the ticket's autopilot flag so the column builds its variables
    // with catch-all safe_tool_overrides when autopilot is driving it.
    const ticketAutopilot = useMemo(() => {
      if (!tab.ticketId) {
        return false;
      }
      return store.tickets.some((t) => t.id === tab.ticketId && t.autopilot === true);
    }, [tab.ticketId, store.tickets]);

    const baseSessionArgs = useMemo(() => {
      if (chatMode) {
        // Chat is projectless but never folder-less: the per-conversation
        // scratch dir is its workspace, and passing it makes the output
        // guidance ("save deliverables in your working folder") apply.
        return {
          surface: 'chat' as const,
          ...(workspaceDir ? { context: { workspaceDir } } : {}),
        };
      }
      const artifactsDir = tab.ticketId
        ? profileRunsOnHost(profileName)
          ? hostConfigDir
            ? getArtifactsDir(hostConfigDir, tab.ticketId)
            : undefined
          : getContainerArtifactsDir(tab.ticketId)
        : undefined;
      return {
        surface: 'code' as const,
        autopilot: ticketAutopilot,
        context: {
          ...(project ? { projectId: project.id, projectLabel: project.label, sources: project.sources } : {}),
          ...(tab.ticketId ? { ticketId: tab.ticketId } : {}),
          ...(artifactsDir ? { artifactsDir } : {}),
          ...(tab.workspaceDir ? { workspaceDir: tab.workspaceDir } : {}),
        },
      };
    }, [chatMode, workspaceDir, tab.ticketId, tab.workspaceDir, project, profileName, hostConfigDir, ticketAutopilot]);

    // Base runs are speak-free; the mic button arms the voice variant per-run.
    const clientToolVariables = useMemo(() => buildSessionVariables(baseSessionArgs), [baseSessionArgs]);
    const personaInstructions = getActivePersona(store).instructions;
    // Track pointer hover per column so the voice-toggle hotkey targets it.
    const onColumnMouseEnter = useCallback(() => $hoveredVoiceScope.set(tab.id), [tab.id]);
    const onColumnMouseLeave = useCallback(() => {
      if ($hoveredVoiceScope.get() === tab.id) {
        $hoveredVoiceScope.set(null);
      }
    }, [tab.id]);
    const voiceVariables = useMemo(
      () => (localVoice ? buildSessionVariables({ ...baseSessionArgs, voice: true, personaInstructions }) : undefined),
      [baseSessionArgs, localVoice, personaInstructions]
    );

    return (
      <div
        className={cn('w-full h-full relative', !isVisible && 'hidden')}
        onMouseEnter={onColumnMouseEnter}
        onMouseLeave={onColumnMouseLeave}
      >
        <SessionStatusBanner status={sandboxStatus} />
        {sandboxUrls ? (
          <VoiceScopeContext.Provider value={tab.id}>
            <CodeRunningView
              sandboxUrls={sandboxUrls}
              environmentId={environmentId}
              sessionId={tab.sessionId}
              onSessionChange={handleSessionChange}
              variables={clientToolVariables}
              voiceVariables={voiceVariables}
              activeApp={activeApp}
              onActiveAppChange={onActiveAppChange}
              onReady={() => {}}
              uiMinimal={uiMinimal}
              headerActionsTargetId={headerActionsTargetId}
              headerActionsCompact={headerActionsCompact}
              sandboxLabel={sandboxLabel}
              sandboxOptions={sandboxOptions}
              currentSandboxProfile={profileName}
              onSandboxChange={handleProfileChange}
              onClientToolCall={handleClientToolCall}
              dockTargetId={dockTargetId}
              tabId={tab.id}
              agentWorkspaceDir={agentWorkspaceDir}
              filesHost={filesHost}
              gitHost={gitHost}
              ticketId={tab.ticketId as TicketId | undefined}
              routineId={tab.routineId}
              switching={sandboxStatus?.type === 'running' && !!sandboxStatus.data.switching}
              greeting={chatMode ? greeting : undefined}
              suggestions={chatMode ? CHAT_SUGGESTIONS : COLUMN_SUGGESTIONS}
              pendingMessages={chatMode ? pendingMessages : undefined}
              onPendingMessagesFlushed={chatMode ? handlePendingMessagesFlushed : undefined}
            />
          </VoiceScopeContext.Provider>
        ) : chatMode ? (
          /* Chat pre-launch / launching / error — the greeting shell. The
             composer is live the whole time: the first submit activates the
             column (lazy launch) and queues the message; queued messages
             flush into the session once the sandbox connects. */
          <ChatShell
            greeting={greeting}
            phase={phase === 'error' ? 'error' : phase === 'idle' && !tab.activatedAt ? 'idle' : 'loading'}
            error={phase === 'error' ? (allLaunchErrors[tab.id] ?? undefined) : undefined}
            onRetry={phase === 'error' ? retry : undefined}
            onSubmit={handlePrelaunchSubmit}
            pendingMessages={pendingMessages}
            suggestions={!tab.activatedAt ? CHAT_SUGGESTIONS : undefined}
            sandboxLabel={sandboxLabel}
            workspaceReady={Boolean(store.workspaceDir)}
            onOpenWorkspaceSettings={() => openSettingsTab('Workspace')}
            prelaunchExtras={
              !tab.activatedAt ? (
                <>
                  <SandboxPicker
                    value={profileName}
                    onChange={handleProfileChange}
                    context={{ isEnterprise, available: store.availableSandboxProfiles }}
                  />
                  <AttachProjectMenu tabId={tab.id} />
                </>
              ) : undefined
            }
          />
        ) : phase === 'error' ? (
          <CodeErrorView tabId={tab.id} retry={retry} />
        ) : (
          /* idle / checking / installing / ready / starting / connecting —
             at this point we already have a project or Routine session
             workspace (we passed the early return above), so auto-launch will
             drive the machine to ``running`` shortly. The in-composer sandbox
             picker handles profile changes; no pre-launch picker needed here. */
          <div className="w-full h-full flex items-center justify-center">
            <motion.div
              className="inline-flex items-center gap-2 rounded-full bg-card pl-5 pr-5 pt-2 pb-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <Spinner className="text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {phase === 'idle' ? 'Restarting sandbox…' : 'Connecting…'}
              </span>
            </motion.div>
          </div>
        )}
      </div>
    );
  }
);
CodeTabContent.displayName = 'CodeTabContent';
