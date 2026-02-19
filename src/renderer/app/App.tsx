import '@/renderer/styles/tailwind.css';
import '@fontsource-variable/inter';
import '@xterm/xterm/css/xterm.css';

import { useStore } from '@nanostores/react';
import { useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ErrorBoundaryFallback } from '@/renderer/app/ErrorBoundaryFallback';
import { MainContent } from '@/renderer/app/MainContent';
import { syncTheme } from '@/renderer/constants';
import { SystemInfoLoadingGate, SystemInfoProvider } from '@/renderer/contexts/SystemInfoContext';
import { Banner } from '@/renderer/features/Banner/Banner';
import { Console } from '@/renderer/features/Console/Console';
import { $sandboxProcessStatus } from '@/renderer/features/Omni/state';
import { SettingsModal } from '@/renderer/features/SettingsModal/SettingsModal';

import { usePreloadTerminalFont } from './use-preload-terminal-font';

export const App = () => {
  usePreloadTerminalFont();
  const sandboxStatus = useStore($sandboxProcessStatus);
  const isSandboxRunning = sandboxStatus.type === 'running';

  useEffect(() => {
    syncTheme();
  }, []);

  return (
    <SystemInfoProvider>
      <div className="w-dvw h-dvh relative overflow-hidden bg-surface font-sans text-fg antialiased">
        <ErrorBoundary FallbackComponent={ErrorBoundaryFallback}>
          <SystemInfoLoadingGate>
            <div className="flex w-full h-full flex-col items-center min-h-0">
              {!isSandboxRunning && <Banner />}
              <MainContent />
            </div>
          </SystemInfoLoadingGate>
          <SettingsModal />
          <Console />
        </ErrorBoundary>
      </div>
    </SystemInfoProvider>
  );
};
