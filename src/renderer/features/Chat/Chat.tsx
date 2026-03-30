import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiMonitorBold } from 'react-icons/pi';

import { OmniAgentsApp, OmniAgentsHostApp } from '@/renderer/omniagents-ui';
import { buildSandboxLabel } from '@/renderer/omniagents-ui/sandbox-label';
import { ChatShell } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { cn } from '@/renderer/ds';
import {
  $omniInstallProcessXTerm,
  $sandboxProcessStatus,
  $sandboxProcessXTerm,
} from '@/renderer/features/Omni/state';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import { $chatProcessStatus, $chatProcessXTerm } from './state';
import type { ChatAutoLaunchPhase } from './use-chat-auto-launch';
import { useChatAutoLaunch } from './use-chat-auto-launch';

const toShellPhase = (phase: ChatAutoLaunchPhase): 'checking' | 'installing' | 'starting' => {
  if (phase === 'checking' || phase === 'installing') return phase;
  return 'starting';
};

const InstallDetails = memo(() => {
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  if (!omniInstallXTerm) return null;
  return <XTermLogViewer $xterm={$omniInstallProcessXTerm} />;
});
InstallDetails.displayName = 'InstallDetails';

const ChatLogDetails = memo(() => {
  const chatXTerm = useStore($chatProcessXTerm);
  if (!chatXTerm) return null;
  return <XTermLogViewer $xterm={$chatProcessXTerm} />;
});
ChatLogDetails.displayName = 'ChatLogDetails';

const SandboxLogDetails = memo(() => {
  const sandboxXTerm = useStore($sandboxProcessXTerm);
  if (!sandboxXTerm) return null;
  return <XTermLogViewer $xterm={$sandboxProcessXTerm} />;
});
SandboxLogDetails.displayName = 'SandboxLogDetails';

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
            <OmniAgentsApp uiUrl={uiSrc} greeting={greeting} sandboxLabel={sandboxLabel} />
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
  const sandboxStatus = useStore($sandboxProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const { phase, error, retry, launch, sandboxEnabled } = useChatAutoLaunch();
  const [greeting] = useState(getGreeting);
  const [runningMounted, setRunningMounted] = useState(false);

  const theme = store.theme ?? 'tokyo-night';
  const sandboxLabel = useMemo(() => (store.sandboxEnabled ? buildSandboxLabel(store.sandboxVariant) : undefined), [store.sandboxEnabled, store.sandboxVariant]);

  // Derive uiUrl from whichever process is active
  const localUiUrl = useMemo(() => {
    if (chatStatus.type !== 'running' && chatStatus.type !== 'connecting') {
      return null;
    }
    const url = new URL(chatStatus.data.uiUrl, window.location.origin);
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    return url.toString();
  }, [chatStatus, theme]);

  const sandboxUrls = useMemo(() => {
    if (sandboxStatus.type !== 'running' && sandboxStatus.type !== 'connecting') {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  // Reset when sandbox URLs go away
  useEffect(() => {
    if (!sandboxUrls) setRunningMounted(false);
  }, [sandboxUrls]);

  const handleRunningReady = useCallback(() => {
    requestAnimationFrame(() => setRunningMounted(true));
  }, []);

  if (!initialized) {
    return null;
  }

  const details =
    phase === 'installing' ? (
      <InstallDetails />
    ) : sandboxEnabled ? (
      <SandboxLogDetails />
    ) : (
      <ChatLogDetails />
    );

  // When sandbox is enabled, use ChatShell + SandboxRunningView (like old Omni.tsx)
  if (sandboxEnabled) {
    const hasUrls = !!sandboxUrls;
    const showShell = !hasUrls || !runningMounted;

    const shellPhase =
      phase === 'error' ? ('error' as const) : phase === 'idle' ? ('idle' as const) : toShellPhase(phase);

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
              details={details}
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
            <SandboxRunningView sandboxUrls={sandboxUrls} theme={theme} greeting={greeting} sandboxLabel={sandboxLabel} />
          </div>
        )}
      </div>
    );
  }

  // When sandbox is disabled, use OmniAgentsHostApp (like old Chat.tsx)
  const startingPhase =
    phase === 'checking' || phase === 'installing' || phase === 'ready' || phase === 'starting'
      ? phase === 'ready'
        ? 'starting'
        : phase
      : 'starting';

  return (
    <div className="w-full h-full">
      <OmniAgentsHostApp
        state={
          localUiUrl
            ? { type: 'ready', uiUrl: localUiUrl }
            : phase === 'idle'
              ? { type: 'idle', onLaunch: launch, disabled: !store.workspaceDir }
              : phase === 'error'
                ? { type: 'error', error: error ?? 'An unexpected error occurred.', onRetry: retry, details }
                : { type: 'starting', phase: startingPhase as 'checking' | 'installing' | 'starting', details }
        }
      />
    </div>
  );
});

Chat.displayName = 'Chat';
