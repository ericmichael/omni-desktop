import '@/renderer/styles/tailwind.css';
import '@fontsource-variable/inter';
import '@xterm/xterm/css/xterm.css';
import '@/renderer/features/Toast/ipc-toast-listener';
import '@/renderer/features/Toast/status-toast-listener';
import '@/renderer/features/WorkspaceSync/state'; // side-effect: registers IPC listener

import { FluentProvider, makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { useEffect, useMemo } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ErrorBoundaryFallback } from '@/renderer/app/ErrorBoundaryFallback';
import { MainContent } from '@/renderer/app/MainContent';
import { syncTheme } from '@/renderer/constants';
import { SystemInfoLoadingGate, SystemInfoProvider } from '@/renderer/contexts/SystemInfoContext';
import { AuthGate } from '@/renderer/features/Auth/AuthGate';
import { Console } from '@/renderer/features/Console/Console';
import { QuickCapture } from '@/renderer/features/Inbox/QuickCapture';
import { ToastContainer } from '@/renderer/features/Toast/ToastContainer';
import { SyncBar } from '@/renderer/features/WorkspaceSync/SyncBar';
import { persistedStoreApi } from '@/renderer/services/store';
import { applyCssVars, fluentThemes } from '@/renderer/theme/fluent-themes';

import { usePreloadTerminalFont } from './use-preload-terminal-font';

const useStyles = makeStyles({
  shell: {
    width: '100dvw',
    height: '100dvh',
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    fontFamily: tokens.fontFamilyBase,
    color: tokens.colorNeutralForeground1,
    WebkitFontSmoothing: 'antialiased',
  },
  layout: {
    display: 'flex',
    width: '100%',
    height: '100%',
    minHeight: 0,
  },
});

export const App = () => {
  usePreloadTerminalFont();
  const store = useStore(persistedStoreApi.$atom);
  const styles = useStyles();

  const themeName = store.theme ?? 'teams-light';
  const fluentTheme = useMemo(() => fluentThemes[themeName], [themeName]);

  useEffect(() => {
    // CSS vars are now injected from fluent-themes.ts (single source of truth).
    // data-theme attribute kept for omniagents-ui backward compat.
    applyCssVars(themeName);
    if (themeName === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themeName);
    }
    syncTheme();
  }, [themeName]);

  return (
    <FluentProvider theme={fluentTheme}>
      <SystemInfoProvider>
        <div className={styles.shell}>
          <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
            <SystemInfoLoadingGate>
              <AuthGate>
                <div className={styles.layout}>
                  <MainContent />
                </div>
                <Console />
                <QuickCapture />
                <SyncBar />
              </AuthGate>
            </SystemInfoLoadingGate>
            <ToastContainer />
          </ErrorBoundary>
        </div>
      </SystemInfoProvider>
    </FluentProvider>
  );
};
