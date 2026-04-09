import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiMonitorBold } from 'react-icons/pi';


import { buildInteractiveVariables } from '@/lib/client-tools';
import { OmniAgentsApp, OmniAgentsHostApp } from '@/renderer/omniagents-ui';
import { buildSandboxLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { ChatShell } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus } from './state';
import { useChatAutoLaunch } from './use-chat-auto-launch';

/** Running view when sandbox is enabled — shows OmniAgentsApp with VNC floating widget. */
const SandboxRunningView = memo(
  ({
    sandboxUrls,
    theme,
    greeting,
    sandboxLabel,
  }: {
    sandboxUrls: {
      uiUrl: string;
      codeServerUrl?: string;
      noVncUrl?: string;
    };
    theme: string;
    greeting?: string;
    sandboxLabel?: string;
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

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <div className="w-full h-full relative">
            <OmniAgentsApp uiUrl={uiSrc} greeting={greeting} sandboxLabel={sandboxLabel} variables={buildInteractiveVariables()} onClientToolCall={buildClientToolHandler()} />
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
      </div>
    );
  }
);
SandboxRunningView.displayName = 'SandboxRunningView';

export const Chat = memo(() => {
  const initialized = useStore($initialized);
  const chatStatus = useStore($chatProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch, sandboxEnabled } = useChatAutoLaunch();
  const [greeting] = useState(getGreeting);
  const [runningMounted, setRunningMounted] = useState(false);

  const theme = store.theme ?? 'tokyo-night';
  const sandboxLabel = useMemo(() => (store.sandboxEnabled ? buildSandboxLabel(store.sandboxVariant) : undefined), [store.sandboxEnabled, store.sandboxVariant]);

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
      <div className="w-full h-full relative">
        {showShell && (
          <div className="absolute inset-0 z-0">
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
            className="absolute inset-0 z-10"
            ref={(el) => {
              if (el) handleRunningReady();
            }}
          >
            <SandboxRunningView sandboxUrls={chatData} theme={theme} greeting={greeting} sandboxLabel={sandboxLabel} />
          </div>
        )}
      </div>
    );
  }

  // When sandbox is disabled, use OmniAgentsHostApp (like old Chat.tsx)
  return (
    <div className="w-full h-full">
      <OmniAgentsHostApp
        variables={buildInteractiveVariables()}
        onClientToolCall={buildClientToolHandler()}
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
