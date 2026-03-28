import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiMonitorBold } from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { Webview } from '@/renderer/common/Webview';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { ChatShell } from '@/renderer/omniagents-ui/ChatShell';
import { getGreeting } from '@/renderer/omniagents-ui/greeting';
import { cn } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { XTermLogViewer } from '@/renderer/features/XTermLogViewer/XTermLogViewer';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode, OmniTheme } from '@/shared/types';

import {
  $omniInstallProcessXTerm,
  $sandboxProcessStatus,
  $sandboxProcessXTerm,
} from './state';
import type { AutoLaunchPhase } from './use-auto-launch';
import { $autoLaunchError, $autoLaunchPhase, useAutoLaunch } from './use-auto-launch';

const OmniRunningView = memo(
  ({
    sandboxUrls,
    store,
    greeting,
  }: {
    sandboxUrls: {
      uiUrl: string;
      codeServerUrl?: string;
      noVncUrl?: string;
    };
    store: { layoutMode: LayoutMode; theme: OmniTheme };
    greeting?: string;
  }) => {
    const layoutMode = store.layoutMode ?? 'work';

    const theme = store.theme ?? 'tokyo-night';
    const uiSrc = useMemo(() => {
      const url = new URL(sandboxUrls.uiUrl, window.location.origin);
      if (theme !== 'default') {
        url.searchParams.set('theme', theme);
      }
      return url.toString();
    }, [sandboxUrls.uiUrl, theme]);
    const codeServerSrc = sandboxUrls.codeServerUrl;
    const vncSrc = sandboxUrls.noVncUrl;

    const hasVnc = Boolean(vncSrc);
    const [vncOverlayOpen, setVncOverlayOpen] = useState(false);

    const handleOpenVncOverlay = useCallback(() => {
      setVncOverlayOpen(true);
    }, []);

    const handleCloseVncOverlay = useCallback(() => {
      setVncOverlayOpen(false);
    }, []);

    return (
      <div className="flex flex-col w-full h-full relative">
        <div className="flex-1 min-h-0 relative">
          <div className={cn('w-full h-full relative', layoutMode !== 'work' && 'hidden')}>
            <OmniAgentsApp uiUrl={uiSrc} greeting={greeting} />
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

          <div className={cn('w-full h-full', layoutMode !== 'desktop' && 'hidden')}>
            <Webview src={vncSrc} showUnavailable={hasVnc} />
          </div>

          <div className={cn('w-full h-full relative', layoutMode !== 'code' && 'hidden')}>
            <CodeSplitLayout uiSrc={uiSrc} codeServerSrc={codeServerSrc} uiMode="omniagents" />
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
OmniRunningView.displayName = 'OmniRunningView';

const toShellPhase = (phase: AutoLaunchPhase): 'checking' | 'installing' | 'starting' => {
  if (phase === 'checking' || phase === 'installing') return phase;
  return 'starting';
};

const InstallDetails = memo(() => {
  const omniInstallXTerm = useStore($omniInstallProcessXTerm);
  if (!omniInstallXTerm) return null;
  return <XTermLogViewer $xterm={$omniInstallProcessXTerm} />;
});
InstallDetails.displayName = 'InstallDetails';

const SandboxLogDetails = memo(() => {
  const sandboxXTerm = useStore($sandboxProcessXTerm);
  if (!sandboxXTerm) return null;
  return <XTermLogViewer $xterm={$sandboxProcessXTerm} />;
});
SandboxLogDetails.displayName = 'SandboxLogDetails';

export const Omni = memo(() => {
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);
  const sandboxStatus = useStore($sandboxProcessStatus);
  const phase = useStore($autoLaunchPhase);
  const error = useStore($autoLaunchError);
  const { retry, launch } = useAutoLaunch();
  const [greeting] = useState(getGreeting);
  const [runningMounted, setRunningMounted] = useState(false);

  const sandboxUrls = useMemo(() => {
    if (sandboxStatus.type !== 'running' && sandboxStatus.type !== 'connecting') {
      return null;
    }
    return sandboxStatus.data;
  }, [sandboxStatus]);

  // Reset when URLs go away
  useEffect(() => {
    if (!sandboxUrls) setRunningMounted(false);
  }, [sandboxUrls]);

  const handleRunningReady = useCallback(() => {
    requestAnimationFrame(() => setRunningMounted(true));
  }, []);

  if (!initialized) {
    return null;
  }

  const hasUrls = !!sandboxUrls;
  const showShell = !hasUrls || !runningMounted;

  const shellPhase = phase === 'error' ? 'error' as const
    : phase === 'idle' ? 'idle' as const
    : toShellPhase(phase);

  const details = phase === 'installing' ? <InstallDetails /> : <SandboxLogDetails />;

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
        <div className="absolute inset-0 z-10" ref={(el) => { if (el) handleRunningReady(); }}>
          <OmniRunningView sandboxUrls={sandboxUrls} store={store} greeting={greeting} />
        </div>
      )}
    </div>
  );
});

Omni.displayName = 'Omni';
