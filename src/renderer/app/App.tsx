import '@/renderer/styles/tailwind.css';
import '@fontsource-variable/inter';
import '@xterm/xterm/css/xterm.css';
import '@/renderer/features/Toast/ipc-toast-listener';
import '@/renderer/features/Toast/status-toast-listener';

import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ErrorBoundaryFallback } from '@/renderer/app/ErrorBoundaryFallback';
import { MainContent } from '@/renderer/app/MainContent';
import { syncTheme } from '@/renderer/constants';
import { SystemInfoLoadingGate, SystemInfoProvider } from '@/renderer/contexts/SystemInfoContext';
import { AuthGate } from '@/renderer/features/Auth/AuthGate';
import { Console } from '@/renderer/features/Console/Console';
import { QuickCapture } from '@/renderer/features/Inbox/QuickCapture';
import { SettingsModal } from '@/renderer/features/SettingsModal/SettingsModal';
import { ToastContainer } from '@/renderer/features/Toast/ToastContainer';
import { persistedStoreApi } from '@/renderer/services/store';

import { usePreloadTerminalFont } from './use-preload-terminal-font';

export const App = () => {
  usePreloadTerminalFont();
  const store = useStore(persistedStoreApi.$atom);

  useEffect(() => {
    const theme = store.theme ?? 'tokyo-night';
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    syncTheme();
  }, [store.theme]);

  return (
    <SystemInfoProvider>
      <div className="w-dvw h-dvh relative overflow-hidden bg-surface font-sans text-fg antialiased">
        <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
          <SystemInfoLoadingGate>
            <AuthGate>
              <div className="flex w-full h-full min-h-0">
                <MainContent />
              </div>
              <SettingsModal />
              <Console />
              <QuickCapture />
            </AuthGate>
          </SystemInfoLoadingGate>
          <ToastContainer />
        </ErrorBoundary>
      </div>
    </SystemInfoProvider>
  );
};
