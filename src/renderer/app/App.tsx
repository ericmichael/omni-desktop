import '@/renderer/styles/tailwind.css';
import '@/renderer/omniagents-ui/styles/index.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@xterm/xterm/css/xterm.css';
import '@/renderer/features/Toast/ipc-toast-listener';
import '@/renderer/features/Toast/status-toast-listener';
import '@/renderer/features/WorkspaceSync/state'; // side-effect: registers IPC listener
import '@/renderer/features/Residents/workspace-tool-bridge'; // side-effect: superuser residents' workspace tools

import { useStore } from '@nanostores/react';
import { MotionConfig } from 'framer-motion';
import { useEffect, useLayoutEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { initBootLanding } from '@/renderer/app/boot-landing';
import { ErrorBoundaryFallback } from '@/renderer/app/ErrorBoundaryFallback';
import { MainContent } from '@/renderer/app/MainContent';
import { StatusAnnouncer } from '@/renderer/app/StatusAnnouncer';
import { syncTheme } from '@/renderer/constants';
import { SystemInfoLoadingGate, SystemInfoProvider } from '@/renderer/contexts/SystemInfoContext';
import { TooltipProvider } from '@/renderer/ds/ui/tooltip';
import { AuthGate } from '@/renderer/features/Auth/AuthGate';
import { ConnectionStatusBanner } from '@/renderer/features/Banner/ConnectionStatusBanner';
import { CommandPalette } from '@/renderer/features/CommandPalette/CommandPalette';
import { QuickCapture } from '@/renderer/features/Inbox/QuickCapture';
import { MigrationNotice } from '@/renderer/features/MigrationNotice/MigrationNotice';
import { ToastContainer } from '@/renderer/features/Toast/ToastContainer';
import { VoiceHotkeys } from '@/renderer/features/Voice/VoiceHotkeys';
import { SyncBar } from '@/renderer/features/WorkspaceSync/SyncBar';
import { initAgentAttention } from '@/renderer/services/agent-attention';
import { initAppHistory } from '@/renderer/services/app-history';
import { initPwaInstall } from '@/renderer/services/pwa-install';
import { persistedStoreApi } from '@/renderer/services/store';
import { applyPwaTheme, applyTheme } from '@/renderer/theme/themes';

import { useAppHeight } from './use-app-height';
import { usePreloadTerminalFont } from './use-preload-terminal-font';

export const App = () => {
  usePreloadTerminalFont();
  useAppHeight();
  const store = useStore(persistedStoreApi.$atom);

  // Platform shell (Phase 8): history/back + document.title, app badge +
  // notifications, PWA install capture. All idempotent.
  useEffect(() => {
    initAppHistory();
    initAgentAttention();
    initPwaInstall();
    initBootLanding();
  }, []);

  const themeName = store.theme ?? 'omni';
  const textScale = store.textScale ?? 100;
  // Root font-size scales every rem-based surface.
  useEffect(() => {
    document.documentElement.style.fontSize = textScale === 100 ? '' : `${textScale}%`;
  }, [textScale]);

  useLayoutEffect(() => {
    // shadcn themes are direct semantic CSS variables selected by data-theme.
    applyTheme(themeName);
    applyPwaTheme(themeName);
    syncTheme();
  }, [themeName]);

  return (
    <TooltipProvider delayDuration={300}>
      {/* All framer-motion animations respect the OS reduce-motion setting.
          Hand-written CSS animations carry their own media-query overrides. */}
      <MotionConfig reducedMotion="user">
        <SystemInfoProvider>
          <div className="app-shell relative flex w-dvw flex-col overflow-hidden bg-background font-sans text-foreground antialiased">
            <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
              <SystemInfoLoadingGate>
                <AuthGate>
                  <ConnectionStatusBanner />
                  <MigrationNotice />
                  <div className="flex min-h-0 w-full flex-1">
                    <MainContent />
                  </div>
                  <QuickCapture />
                  <VoiceHotkeys />
                  <CommandPalette />
                  <SyncBar />
                  <StatusAnnouncer />
                </AuthGate>
              </SystemInfoLoadingGate>
              <ToastContainer />
            </ErrorBoundary>
          </div>
        </SystemInfoProvider>
      </MotionConfig>
    </TooltipProvider>
  );
};
