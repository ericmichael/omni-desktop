import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Desktop20Regular } from '@fluentui/react-icons';

import { buildInteractiveVariables } from '@/lib/client-tools';
import { OmniAgentsApp, OmniAgentsHostApp } from '@/renderer/omniagents-ui';
import { buildSandboxLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { $pendingPlan, resolvePlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { ChatShell } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { $chatProcessStatus } from './state';
import { useChatAutoLaunch } from './use-chat-auto-launch';

const useStyles = makeStyles({
  fullSize: { width: '100%', height: '100%' },
  fullSizeRelative: { width: '100%', height: '100%', position: 'relative' },
  flexColFullRelative: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative' },
  flex1Relative: { flex: '1 1 0', minHeight: 0, position: 'relative' },
  absoluteInsetZ0: { position: 'absolute', inset: 0, zIndex: 0 },
  absoluteInsetZ10: { position: 'absolute', inset: 0, zIndex: 10 },
  projectSelect: {
    position: 'absolute',
    top: tokens.spacingVerticalS,
    right: tokens.spacingHorizontalM,
    zIndex: 20,
    fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    cursor: 'pointer',
    outline: 'none',
  },
});

/** Small project picker in the chat header area. */
const ChatProjectPicker = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const projects = store.projects;
  const chatProjectId = store.chatProjectId ?? '';

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    persistedStoreApi.setKey('chatProjectId', value || null);
  }, []);

  if (projects.length === 0) return null;

  return (
    <select
      className={styles.projectSelect}
      value={chatProjectId}
      onChange={handleChange}
      aria-label="Chat project context"
    >
      <option value="">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
});
ChatProjectPicker.displayName = 'ChatProjectPicker';

/** Hook to get project context variables and tool handler for the selected chat project. */
function useChatProjectContext() {
  const store = useStore(persistedStoreApi.$atom);
  const chatProjectId = store.chatProjectId ?? null;
  const project = chatProjectId ? store.projects.find((p) => p.id === chatProjectId) : null;

  const variables = useMemo(
    () =>
      buildInteractiveVariables(
        project ? { projectId: project.id, projectLabel: project.label } : undefined
      ),
    [project]
  );

  const toolHandler = useMemo(
    () =>
      buildClientToolHandler(
        project ? { projectId: project.id as ProjectId } : undefined
      ),
    [project]
  );

  return { variables, toolHandler };
}

/** Running view when sandbox is enabled — shows OmniAgentsApp with VNC floating widget. */
const SandboxRunningView = memo(
  ({
    sandboxUrls,
    theme,
    greeting,
    sandboxLabel,
    sessionId,
    onSessionChange,
    variables,
    onClientToolCall,
  }: {
    sandboxUrls: {
      uiUrl: string;
      codeServerUrl?: string;
      noVncUrl?: string;
    };
    theme: string;
    greeting?: string;
    sandboxLabel?: string;
    sessionId?: string;
    onSessionChange?: (sessionId: string | undefined) => void;
    variables?: Record<string, unknown>;
    onClientToolCall?: Parameters<typeof OmniAgentsApp>[0]['onClientToolCall'];
  }) => {
    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl, window.location.origin);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme]);
    const vncSrc = sandboxUrls.noVncUrl;

    const [vncOverlayOpen, setVncOverlayOpen] = useState(false);
    const handleOpenVncOverlay = useCallback(() => setVncOverlayOpen(true), []);
    const handleCloseVncOverlay = useCallback(() => setVncOverlayOpen(false), []);
    const pendingPlan = useStore($pendingPlan);

    const styles = useStyles();
    return (
      <div className={styles.flexColFullRelative}>
        <div className={styles.flex1Relative}>
          <div className={styles.fullSizeRelative}>
            <OmniAgentsApp uiUrl={uiSrc} greeting={greeting} sandboxLabel={sandboxLabel} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables ?? buildInteractiveVariables()} onClientToolCall={onClientToolCall ?? buildClientToolHandler()} pendingPlan={pendingPlan} onPlanDecision={resolvePlanApproval} />
            {vncSrc && (
              <FloatingWidget
                src={vncSrc}
                label="Omni's PC"
                icon={Desktop20Regular}
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
SandboxRunningView.displayName = 'SandboxRunningView';

export const Chat = memo(() => {
  const styles = useStyles();
  const initialized = useStore($initialized);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch, sandboxEnabled } = useChatAutoLaunch();
  const [greeting] = useState(getGreeting);
  const [runningMounted, setRunningMounted] = useState(false);
  const pendingPlan = useStore($pendingPlan);
  const { variables, toolHandler } = useChatProjectContext();

  const theme = store.theme ?? 'teams-light';
  const sandboxBackend = store.sandboxBackend ?? 'none';
  const sandboxLabel = useMemo(() => (sandboxBackend !== 'none' ? buildSandboxLabel(sandboxBackend) : undefined), [sandboxBackend]);

  const chatSessionId = store.chatSessionId ?? undefined;
  const handleSessionChange = useCallback((sessionId: string | undefined) => {
    persistedStoreApi.setKey('chatSessionId', sessionId ?? null);
  }, []);

  // Derive URLs from chatStatus (unified — handles both local and sandbox modes)
  const chatData = useMemo(() => {
    if (chatStatus.type !== 'running' && chatStatus.type !== 'connecting') {
      return null;
    }
    return chatStatus.data;
  }, [chatStatus]);

  const localUiUrl = useMemo(() => {
    if (!chatData) return null;
    const url = new URL(chatData.uiUrl, window.location.origin);
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    return url.toString();
  }, [chatData, theme]);

  // Reset when URLs go away
  useEffect(() => {
    if (!chatData) setRunningMounted(false);
  }, [chatData]);

  const handleRunningReady = useCallback(() => {
    requestAnimationFrame(() => setRunningMounted(true));
  }, []);

  if (!initialized) {
    return null;
  }

  // When sandbox is enabled, use ChatShell + SandboxRunningView (like old Omni.tsx)
  if (sandboxEnabled) {
    const hasUrls = !!chatData;
    const showShell = !hasUrls || !runningMounted;

    const shellPhase =
      phase === 'error' ? ('error' as const) : phase === 'idle' ? ('idle' as const) : ('loading' as const);

    return (
      <div className={styles.fullSizeRelative}>
        <ChatProjectPicker />
        {showShell && (
          <div className={styles.absoluteInsetZ0}>
            <ChatShell
              greeting={greeting}
              phase={shellPhase}
              error={phase === 'error' ? error : undefined}
              onRetry={phase === 'error' ? retry : undefined}
              onLaunch={phase === 'idle' ? launch : undefined}
              launchDisabled={phase === 'idle' ? !store.workspaceDir : undefined}
            />
          </div>
        )}
        {hasUrls && (
          <div
            className={styles.absoluteInsetZ10}
            ref={(el) => {
              if (el) handleRunningReady();
            }}
          >
            <SandboxRunningView sandboxUrls={chatData} theme={theme} greeting={greeting} sandboxLabel={sandboxLabel} sessionId={chatSessionId} onSessionChange={handleSessionChange} variables={variables} onClientToolCall={toolHandler} />
          </div>
        )}
      </div>
    );
  }

  // When sandbox is disabled, use OmniAgentsHostApp (like old Chat.tsx)
  return (
    <div className={styles.fullSize}>
      <ChatProjectPicker />
      <OmniAgentsHostApp
        variables={variables}
        onClientToolCall={toolHandler}
        pendingPlan={pendingPlan}
        onPlanDecision={resolvePlanApproval}
        sessionId={chatSessionId}
        onSessionChange={handleSessionChange}
        state={
          localUiUrl
            ? { type: 'ready', uiUrl: localUiUrl }
            : phase === 'idle'
              ? { type: 'idle', onLaunch: launch, disabled: !store.workspaceDir }
              : phase === 'error'
                ? { type: 'error', error: error ?? 'An unexpected error occurred.', onRetry: retry }
                : { type: 'loading' }
        }
      />
    </div>
  );
});

Chat.displayName = 'Chat';
