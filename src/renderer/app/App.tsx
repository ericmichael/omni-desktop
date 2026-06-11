import '@/renderer/styles/tailwind.css';
import '@/renderer/omniagents-ui/styles/index.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@xterm/xterm/css/xterm.css';
import '@/renderer/features/Toast/ipc-toast-listener';
import '@/renderer/features/Toast/status-toast-listener';
import '@/renderer/features/WorkspaceSync/state'; // side-effect: registers IPC listener

import { FluentProvider, makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { MotionConfig } from 'framer-motion';
import { useEffect, useMemo } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ErrorBoundaryFallback } from '@/renderer/app/ErrorBoundaryFallback';
import { MainContent } from '@/renderer/app/MainContent';
import { StatusAnnouncer } from '@/renderer/app/StatusAnnouncer';
import { syncTheme } from '@/renderer/constants';
import { SystemInfoLoadingGate, SystemInfoProvider } from '@/renderer/contexts/SystemInfoContext';
import { AuthGate } from '@/renderer/features/Auth/AuthGate';
import { CommandPalette } from '@/renderer/features/CommandPalette/CommandPalette';
import { GlobalAgent } from '@/renderer/features/GlobalAgent/GlobalAgent';
import { GlobalAgentAmbientGlow } from '@/renderer/features/GlobalAgent/GlobalAgentAmbientGlow';
import { QuickCapture } from '@/renderer/features/Inbox/QuickCapture';
import { MigrationNotice } from '@/renderer/features/MigrationNotice/MigrationNotice';
import { ToastContainer } from '@/renderer/features/Toast/ToastContainer';
import { VoiceHotkeys } from '@/renderer/features/Voice/VoiceHotkeys';
import { SyncBar } from '@/renderer/features/WorkspaceSync/SyncBar';
import { initAgentAttention } from '@/renderer/services/agent-attention';
import { initAppHistory } from '@/renderer/services/app-history';
import { initPwaInstall } from '@/renderer/services/pwa-install';
import { persistedStoreApi } from '@/renderer/services/store';
import { applyCssVars, applyPwaTheme, getFluentTheme, isThemeDark } from '@/renderer/theme/fluent-themes';

import { useAppHeight } from './use-app-height';
import { usePreloadTerminalFont } from './use-preload-terminal-font';

const useStyles = makeStyles({
  shell: {
    width: '100dvw',
    /* --app-height is set by useAppHeight ONLY while an on-screen keyboard
       overlays the page (iOS), shrinking the shell above it. At rest the var
       is absent and 100dvh applies.

       Do NOT size the shell past the layout viewport (e.g. 100vh in
       standalone). On iOS standalone cold start the layout viewport can be
       short by the status bar while the window paints full-bleed — and
       element painting is CLIPPED at the short viewport (verified
       on-device), so a taller shell just slices the bottom tab bar off.
       That state is handled instead by useAppHeight zeroing
       --safe-area-bottom: the nav-colored --safe-area-background backstop
       band below the viewport doubles as the home-indicator clearance. */
    height: 'var(--app-height, 100dvh)',
    paddingTop: 'env(safe-area-inset-top, 0px)',
    paddingLeft: 'env(safe-area-inset-left, 0px)',
    paddingRight: 'env(safe-area-inset-right, 0px)',
    position: 'relative',
    overflow: 'hidden',
    // Flex column so the post-migration notice (rendered above the main
    // layout when present) doesn't fight the layout for vertical space —
    // it shrinks to its content and `.layout` consumes the rest.
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    fontFamily: tokens.fontFamilyBase,
    color: tokens.colorNeutralForeground1,
    WebkitFontSmoothing: 'antialiased',
  },
  layout: {
    display: 'flex',
    width: '100%',
    flex: '1 1 0',
    minHeight: 0,
  },
});

export const App = () => {
  usePreloadTerminalFont();
  useAppHeight();
  const store = useStore(persistedStoreApi.$atom);
  const styles = useStyles();

  // Platform shell (Phase 8): history/back + document.title, app badge +
  // notifications, PWA install capture. All idempotent.
  useEffect(() => {
    initAppHistory();
    initAgentAttention();
    initPwaInstall();
  }, []);

  const themeName = store.theme ?? 'omni';
  const textScale = store.textScale ?? 100;
  const fluentTheme = useMemo(() => getFluentTheme(themeName, textScale), [themeName, textScale]);

  // "Text size": the Fluent ramp is scaled in getFluentTheme; the root
  // font-size scales every rem-based surface (Tailwind / omniagents-ui).
  useEffect(() => {
    document.documentElement.style.fontSize = textScale === 100 ? '' : `${textScale}%`;
  }, [textScale]);

  useEffect(() => {
    // CSS vars are now injected from fluent-themes.ts (single source of truth).
    // data-theme attribute kept for omniagents-ui backward compat.
    applyCssVars(themeName);
    applyPwaTheme(themeName);
    if (themeName === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themeName);
    }
    // Toggle .dark class for Tailwind dark: variant (used by @yoopta/themes-shadcn)
    document.documentElement.classList.toggle('dark', isThemeDark(themeName));
    syncTheme();
  }, [themeName]);

  return (
    <FluentProvider theme={fluentTheme}>
      {/* All framer-motion animations respect the OS reduce-motion setting.
          Hand-written CSS animations carry their own media-query overrides. */}
      <MotionConfig reducedMotion="user">
      <SystemInfoProvider>
        <div className={styles.shell}>
          <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
            <SystemInfoLoadingGate>
              <AuthGate>
                <MigrationNotice />
                <div className={styles.layout}>
                  <MainContent />
                </div>
                <QuickCapture />
                <GlobalAgent />
                <GlobalAgentAmbientGlow />
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
    </FluentProvider>
  );
};
