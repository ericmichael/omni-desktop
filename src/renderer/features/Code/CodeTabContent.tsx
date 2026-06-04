import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { getArtifactsDir, getContainerArtifactsDir, profileRunsOnHost } from '@/lib/artifacts';
import { buildSessionVariables } from '@/lib/client-tools';
import { SessionStartupShell } from '@/renderer/common/SessionStartupShell';
import { Button, Spinner } from '@/renderer/ds';
import { SessionStatusBanner } from '@/renderer/features/Banner/SessionStatusBanner';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { $pendingPlan, resolvePlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { useSandboxActivityPing } from '@/renderer/hooks/use-sandbox-activity-ping';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { buildProfileLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { configApi } from '@/renderer/services/config';
import { emitter, serverOrigin } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { persistedStoreApi } from '@/renderer/services/store';
import { isLocalVoiceCapable } from '@/renderer/services/voice-client';
import { VoiceScopeContext } from '@/renderer/services/voice-recording';
import type { AppId } from '@/shared/app-registry';
import type { CodeTab, CodeTabId, TicketId } from '@/shared/types';
import { firstSource } from '@/shared/types';
import { getActivePersona } from '@/shared/voice-personas';

import { CodeEmptyState } from './CodeEmptyState';
import { CodeWorkspaceLayout } from './CodeWorkspaceLayout';
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
  // In-place sandbox-switch scrim — dims the still-mounted agent column while
  // the sandbox is rebuilt; the conversation reappears intact when it clears.
  switchScrim: {
    position: 'absolute',
    inset: 0,
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    backdropFilter: 'blur(1px)',
    WebkitBackdropFilter: 'blur(1px)',
  },
  switchCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXXL}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    maxWidth: '320px',
    textAlign: 'center',
  },
  switchTitle: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  switchHint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
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
    previewUrl,
    onPreviewUrlChange,
    dockTargetId,
    isGlass,
    tabId,
    agentWorkspaceDir,
    sidecarMode,
    ticketId,
    switching,
  }: {
    sandboxUrls: { uiUrl: string; services?: Record<string, string> };
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
    previewUrl?: string;
    onPreviewUrlChange?: (url: string) => void;
    dockTargetId?: string;
    isGlass?: boolean;
    tabId?: string;
    agentWorkspaceDir?: string;
    sidecarMode?: boolean;
    ticketId?: TicketId;
    switching?: boolean;
  }) => {
    const styles = useStyles();
    const store = useStore(persistedStoreApi.$atom);
    const theme = store.theme ?? 'teams-light';
    const pendingPlan = useStore($pendingPlan);

    const uiSrc = useMemo(() => {
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
      return url.toString();
    }, [sandboxUrls.uiUrl, theme, uiMinimal]);
    const codeServerSrc = sandboxUrls.services?.['code_server'];
    const vncSrc = sandboxUrls.services?.['vnc'];

    return (
      <div className={styles.flexColFullRelative}>
        <div className={styles.flex1Relative}>
          <CodeWorkspaceLayout
            uiSrc={uiSrc}
            sessionId={sessionId}
            onSessionChange={onSessionChange}
            variables={variables}
            voiceVariables={voiceVariables}
            codeServerSrc={codeServerSrc}
            vncSrc={vncSrc}
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
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
            isGlass={isGlass}
            tabId={tabId}
            agentWorkspaceDir={agentWorkspaceDir}
            sidecarMode={sidecarMode}
            ticketId={ticketId}
          />
        </div>
        {switching && (
          <div className={styles.switchScrim}>
            <div className={styles.switchCard}>
              <Spinner size="md" />
              <span className={styles.switchTitle}>
                Switching to {getProfileMenuLabel(currentSandboxProfile ?? 'host')}…
              </span>
              <span className={styles.switchHint}>Your conversation and files are preserved.</span>
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
  previewUrl?: string;
  onPreviewUrlChange?: (url: string) => void;
  dockTargetId?: string;
  isGlass?: boolean;
  sidecarMode?: boolean;
};

export const CodeTabContent = memo(
  ({ tab, isVisible, activeApp = 'chat', onActiveAppChange, uiMinimal, headerActionsTargetId, headerActionsCompact, previewUrl, onPreviewUrlChange, dockTargetId, isGlass, sidecarMode }: CodeTabContentProps) => {
    const styles = useStyles();
    const store = useStore(persistedStoreApi.$atom);
    const project = useMemo(
      () => store.projects.find((p) => p.id === tab.projectId) ?? null,
      [store.projects, tab.projectId]
    );
    // Projects without a linked local source still have a managed directory on
    // disk (`Projects/<slug>/` or `~/Omni/Workspace/` for Personal). Resolve it
    // lazily so the sandbox can start even when the user hasn't picked a
    // workspace.
    const projectSource = firstSource(project);
    const linkedWorkspaceDir = tab.workspaceDir ?? (projectSource?.kind === 'local' ? projectSource.workspaceDir : null) ?? null;
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
    const workspaceDir = linkedWorkspaceDir ?? resolvedProjectDir;

    // Sticky profile binding persisted on the tab. The migration backfills
    // existing installs; ``codeApi.addTab*`` seeds new tabs from the same
    // resolution chain (per-project ``sandboxProfile`` → user default) so we
    // don't drift if the user changes defaults later. The picker writes
    // through ``codeApi.setTabProfile`` and the new value flows back via
    // ``useStore``. The ``project?.sandboxProfile`` / ``store.defaultProfileName``
    // fallbacks below only kick in for tabs predating the migration that
    // somehow got loaded without a stored profileName (defensive).
    const profileName =
      tab.profileName ?? project?.sandboxProfile ?? store.defaultProfileName ?? 'host';
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
      () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles }).map((name) => ({
        value: name,
        label: getProfileMenuLabel(name, machines),
      })),
      [isEnterprise, store.availableSandboxProfiles, machines]
    );

    // What the agent should treat as its workspace root. For host profiles
    // the agent runs on the host, so the host path is correct. For
    // containerized profiles (docker, e2b, …) the agent's filesystem root is
    // ``/workspace/<mountName>`` (or just ``/workspace`` when no source has
    // been attached) — passing a host path here would land in
    // ``session.variables.workspace_root`` and make every ``execute_bash``
    // try to ``cd`` to a path that doesn't exist inside the container.
    const agentWorkspaceDir = useMemo(() => {
      if (profileRunsOnHost(profileName)) {
        return workspaceDir ?? undefined;
      }
      const mountName = projectSource?.mountName;
      return mountName ? `/workspace/${mountName}` : '/workspace';
    }, [profileName, workspaceDir, projectSource]);

    const { phase, retry } = useCodeAutoLaunch(tab.id, workspaceDir, {
      ...(tab.projectId ? { projectId: tab.projectId } : {}),
      profileNameOverride: profileName,
      ...(tab.sessionId ? { sessionId: tab.sessionId } : {}),
      ...(tab.containerId ? { containerId: tab.containerId } : {}),
    });
    useSandboxActivityPing(tab.id);

    const allStatuses = useStore($codeTabStatuses);
    const sandboxStatus = allStatuses[tab.id];

    // Capture the readiness payload's container_id whenever this tab's omni
    // serve reports running. May differ from what we sent on this launch if
    // the SDK ended up creating a fresh container (rehydrate / fresh tiers),
    // which is exactly what we want to persist for the next start.
    useEffect(() => {
      if (sandboxStatus?.type !== 'running') {
return;
}
      const next = sandboxStatus.data.containerId;
      if ((tab.containerId ?? undefined) === next) {
return;
}
      void codeApi.setTabContainerId(tab.id, next);
    }, [sandboxStatus, tab.id, tab.containerId]);

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
    }, [tab.ticketId, tab.workspaceDir, project, profileName, hostConfigDir, ticketAutopilot]);

    // Base runs are speak-free; the mic button arms the voice variant per-run.
    const clientToolVariables = useMemo(() => buildSessionVariables(baseSessionArgs), [baseSessionArgs]);
    const personaInstructions = getActivePersona(store).instructions;
    const voiceVariables = useMemo(
      () =>
        localVoice
          ? buildSessionVariables({ ...baseSessionArgs, voice: true, personaInstructions })
          : undefined,
      [baseSessionArgs, localVoice, personaInstructions],
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
        <SessionStatusBanner status={sandboxStatus} />
        {sandboxUrls ? (
          <VoiceScopeContext.Provider value={tab.id}>
          <CodeRunningView
            sandboxUrls={sandboxUrls}
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
            previewUrl={previewUrl}
            onPreviewUrlChange={onPreviewUrlChange}
            dockTargetId={dockTargetId}
            isGlass={isGlass}
            tabId={tab.id}
            agentWorkspaceDir={agentWorkspaceDir}
            sidecarMode={sidecarMode}
            ticketId={tab.ticketId as TicketId | undefined}
            switching={sandboxStatus?.type === 'running' && !!sandboxStatus.data.switching}
          />
          </VoiceScopeContext.Provider>
        ) : phase === 'error' ? (
          <CodeErrorView tabId={tab.id} retry={retry} />
        ) : (
          /* idle / checking / installing / ready / starting / connecting —
             at this point we already have tab.projectId (we passed the
             early return above), so auto-launch will drive the machine to
             ``running`` shortly. The in-composer sandbox picker handles
             profile changes; no pre-launch picker needed here. */
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
              <span className={styles.spinnerText}>
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
