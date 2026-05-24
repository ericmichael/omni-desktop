import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Desktop20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { buildSessionVariables } from '@/lib/client-tools';
import { Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { $pendingPlan, resolvePlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { useSandboxActivityPing } from '@/renderer/hooks/use-sandbox-activity-ping';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { ChatShell } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { buildProfileLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus } from './state';
import { useChatAutoLaunch } from './use-chat-auto-launch';

const useStyles = makeStyles({
  fullSize: { width: '100%', height: '100%' },
  fullSizeRelative: { width: '100%', height: '100%', position: 'relative' },
  flexColFullRelative: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative' },
  flex1Relative: { flex: '1 1 0', minHeight: 0, position: 'relative' },
  absoluteInsetZ0: { position: 'absolute', inset: 0, zIndex: 0 },
  absoluteInsetZ10: { position: 'absolute', inset: 0, zIndex: 10 },
  // Non-blocking transition scrim shown over the still-mounted conversation
  // while an in-place sandbox switch runs. Dims (not hides) the chat and blocks
  // re-clicks; the conversation reappears intact when the switch resolves.
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
  // Inner surface bg/border colors for chat content come from the Tailwind
  // var overrides pushed at the deck-bg root in MainContent (--color-bgCard,
  // --color-background, etc. resolve to the glass scrim). This class only
  // adds the blur layer to the chat shell, keeps the primary CTA semi-
  // translucent, and rebuilds the chat composer footer as a glass capsule.
  glassRoot: {
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
    '& .bg-primary': {
      backgroundColor: `color-mix(in srgb, ${tokens.colorBrandBackground} 70%, transparent)`,
      backdropFilter: 'var(--glass-blur-light)',
      WebkitBackdropFilter: 'var(--glass-blur-light)',
      boxShadow: `0 1px 0 0 rgba(255,255,255,0.14) inset, 0 2px 8px -2px rgba(0,0,0,0.15)`,
    },
    '& .chat-input-footer': {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      borderTop: `1px solid var(--colorNeutralStroke1)`,
    },
    '& .chat-input-footer::before': {
      content: '""',
      position: 'absolute',
      top: '12px',
      right: '12px',
      bottom: '12px',
      left: '12px',
      borderRadius: '24px',
      boxShadow: '0 0 0 9999px rgba(255, 255, 255, 0.06)',
      pointerEvents: 'none',
      zIndex: 0,
    },
    '& .chat-input-footer > *': {
      position: 'relative',
      zIndex: 1,
    },
    '& .chat-input-footer .bg-bgCardAlt': {
      backgroundColor: 'transparent',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    },
  },
});

/** Running view when sandbox is enabled — shows OmniAgentsApp with VNC floating widget. */
const SandboxRunningView = memo(
  ({
    sandboxUrls,
    theme,
    greeting,
    sandboxLabel,
    sandboxOptions,
    currentSandboxProfile,
    onSandboxChange,
    sessionId,
    onSessionChange,
    variables,
    onClientToolCall,
    workspaceDir,
  }: {
    sandboxUrls: {
      uiUrl: string;
      services?: Record<string, string>;
    };
    theme: string;
    greeting?: string;
    sandboxLabel?: string;
    sandboxOptions?: { value: string; label: string }[];
    currentSandboxProfile?: string;
    onSandboxChange?: (value: string) => void;
    sessionId?: string;
    onSessionChange?: (sessionId: string | undefined) => void;
    variables?: Record<string, unknown>;
    onClientToolCall?: Parameters<typeof OmniAgentsApp>[0]['onClientToolCall'];
    workspaceDir?: string;
  }) => {
    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl, window.location.origin);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme]);
    const vncSrc = sandboxUrls.services?.['vnc'];

    const [vncOverlayOpen, setVncOverlayOpen] = useState(false);
    const handleOpenVncOverlay = useCallback(() => setVncOverlayOpen(true), []);
    const handleCloseVncOverlay = useCallback(() => setVncOverlayOpen(false), []);
    const pendingPlan = useStore($pendingPlan);

    const styles = useStyles();
    return (
      <div className={styles.flexColFullRelative}>
        <div className={styles.flex1Relative}>
          <div className={styles.fullSizeRelative}>
            <OmniAgentsApp uiUrl={uiSrc} greeting={greeting} sandboxLabel={sandboxLabel} sandboxOptions={sandboxOptions} currentSandboxProfile={currentSandboxProfile} onSandboxChange={onSandboxChange} sessionId={sessionId} onSessionChange={onSessionChange} variables={variables ?? buildSessionVariables({ surface: 'chat' })} onClientToolCall={onClientToolCall ?? buildClientToolHandler()} pendingPlan={pendingPlan} onPlanDecision={resolvePlanApproval} workspaceDir={workspaceDir} />
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
  const { phase, error, retry, launch, profileName } = useChatAutoLaunch();
  useSandboxActivityPing('chat');
  // Picker writes the sticky binding (``StoreData.chatProfileName``) — the
  // hook re-reads on the next render and forwards it as the launch override.
  // The stored ``chatContainerId`` is profile-specific (different profile
  // = different image), so clearing it here keeps a stale id from getting
  // sent on the next start; the SDK would gracefully fall back anyway, but
  // not sending it at all is cleaner and saves an unnecessary docker query.
  const handleProfileChange = useCallback((value: string) => {
    void persistedStoreApi.setKey('chatProfileName', value);
    void persistedStoreApi.setKey('chatContainerId', null);
  }, []);
  const [greeting] = useState(getGreeting);
  const [runningMounted, setRunningMounted] = useState(false);
  const [isEnterprise, setIsEnterprise] = useState(false);
  const variables = useMemo(() => buildSessionVariables({ surface: 'chat' }), []);
  const toolHandler = useMemo(() => buildClientToolHandler(), []);

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const isGlass = !!store.codeDeckBackground;
  const theme = store.theme ?? 'teams-light';
  const sandboxLabel = useMemo(() => buildProfileLabel(profileName), [profileName]);
  const sandboxOptions = useMemo(
    () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles }).map((name) => ({
      value: name,
      label: getProfileMenuLabel(name),
    })),
    [isEnterprise, store.availableSandboxProfiles]
  );

  const chatSessionId = store.chatSessionId ?? undefined;
  const handleSessionChange = useCallback((sessionId: string | undefined) => {
    persistedStoreApi.setKey('chatSessionId', sessionId ?? null);
  }, []);

  // Every chat goes through `omni serve` after the v22 cut — the JSON-RPC
  // WebSocket URL lives in chatData.uiUrl regardless of profile.
  //
  // Only mount the iframe on ``running``. ``connecting`` arrives the moment
  // omni-serve emits its JSON readiness line, which is *before* uvicorn has
  // actually bound the port — pointing the iframe there causes a brief
  // ERR_CONNECTION_REFUSED / uvicorn error flash before the real UI loads.
  // ``agent-process.ts`` already gates the ``running`` flip on an HTTP+WS
  // health probe, so by the time we see it the port is truly serving.
  const chatData = useMemo(() => {
    if (chatStatus.type !== 'running') {
      return null;
    }
    return chatStatus.data;
  }, [chatStatus]);

  useEffect(() => {
    if (!chatData) {
      setRunningMounted(false);
    }
  }, [chatData]);

  const handleRunningReady = useCallback(() => {
    requestAnimationFrame(() => setRunningMounted(true));
  }, []);

  if (!initialized) {
    return null;
  }

  const hasUrls = !!chatData;
  const showShell = !hasUrls || !runningMounted;
  const shellPhase =
    phase === 'error' ? ('error' as const) : phase === 'idle' ? ('idle' as const) : ('loading' as const);

  return (
    <div className={mergeClasses(styles.fullSizeRelative, isGlass && styles.glassRoot)}>
      {showShell && (
        <div className={styles.absoluteInsetZ0}>
          <ChatShell
            greeting={greeting}
            phase={shellPhase}
            error={phase === 'error' ? error : undefined}
            onRetry={phase === 'error' ? retry : undefined}
            onLaunch={phase === 'idle' ? launch : undefined}
            launchDisabled={phase === 'idle' ? !store.workspaceDir : undefined}
            prelaunchExtras={
              phase === 'idle' ? (
                <SandboxPicker
                  value={profileName}
                  onChange={handleProfileChange}
                  context={{ isEnterprise, available: store.availableSandboxProfiles }}
                />
              ) : undefined
            }
          />
        </div>
      )}
      {hasUrls && (
        <div
          className={styles.absoluteInsetZ10}
          ref={(el) => {
            if (el) {
              handleRunningReady();
            }
          }}
        >
          <SandboxRunningView
            sandboxUrls={chatData}
            theme={theme}
            greeting={greeting}
            sandboxLabel={sandboxLabel}
            sandboxOptions={sandboxOptions}
            currentSandboxProfile={profileName}
            onSandboxChange={handleProfileChange}
            sessionId={chatSessionId}
            onSessionChange={handleSessionChange}
            variables={variables}
            onClientToolCall={toolHandler}
            workspaceDir={store.workspaceDir ?? undefined}
          />
          {chatData.switching && (
            <div className={styles.switchScrim}>
              <div className={styles.switchCard}>
                <Spinner size="md" />
                <span className={styles.switchTitle}>Switching to {getProfileMenuLabel(profileName)}…</span>
                <span className={styles.switchHint}>Your conversation and files are preserved.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

Chat.displayName = 'Chat';
