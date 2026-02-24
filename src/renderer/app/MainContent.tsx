import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo } from 'react';
import { PiStopFill } from 'react-icons/pi';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { cn, IconButton } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { Chat } from '@/renderer/features/Chat/Chat';
import { $chatProcessStatus, chatApi } from '@/renderer/features/Chat/state';
import { Fleet } from '@/renderer/features/Fleet/Fleet';
import { Omni } from '@/renderer/features/Omni/Omni';
import { $sandboxProcessStatus, sandboxApi } from '@/renderer/features/Omni/state';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const ALL_TABS: { value: LayoutMode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'work', label: 'Work' },
  { value: 'code', label: 'Code' },
  { value: 'fleet', label: 'Fleet' },
];

/**
 * Map layout modes to the tab that should appear active.
 * 'desktop' is a sub-mode of 'code', so Code tab stays highlighted.
 */
const activeTabForMode = (mode: LayoutMode): LayoutMode => {
  if (mode === 'desktop') {
    return 'code';
  }
  return mode;
};

export const MainContent = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const sandboxStatus = useStore($sandboxProcessStatus);
  const chatStatus = useStore($chatProcessStatus);
  const launcherVersion = useStore($launcherVersion);

  const setMode = useCallback(
    (mode: LayoutMode) => () => {
      persistedStoreApi.setKey('layoutMode', mode);
    },
    []
  );

  const stopSandbox = useCallback(() => {
    sandboxApi.stop();
  }, []);

  const stopChat = useCallback(() => {
    chatApi.stop();
  }, []);

  const visibleTabs = useMemo(
    () =>
      import.meta.env.DEV
        ? ALL_TABS
        : ALL_TABS.filter((t) => t.value !== 'fleet' && t.value !== 'work' && t.value !== 'code'),
    []
  );

  if (!store.onboardingComplete) {
    return <OnboardingWizard />;
  }

  const activeTab = activeTabForMode(store.layoutMode);
  const sandboxRunning = sandboxStatus.type === 'running';
  const chatRunning = chatStatus.type === 'running';

  return (
    <div className="flex flex-col w-full h-full">
      {/* Single toolbar: logo, tabs, controls */}
      <div className="flex items-center px-3 py-1.5 border-b border-surface-border shrink-0 bg-surface">
        <div className="flex items-center gap-2">
          <AsciiLogo className="text-[5px]" />
          {launcherVersion && (
            <span className="text-[10px] text-fg-subtle bg-white/5 px-1.5 py-0.5 rounded-full select-none">
              v{launcherVersion}
            </span>
          )}
        </div>

        <div className="flex-1 flex justify-center">
          <div className="flex bg-surface-raised rounded-lg p-0.5 gap-0.5">
            {visibleTabs.map((tab) => {
              const isActive = activeTab === tab.value;
              return (
                <button
                  key={tab.value}
                  onClick={setMode(tab.value)}
                  className={cn(
                    'relative px-4 py-1 text-xs rounded-md transition-colors cursor-pointer select-none',
                    isActive ? 'text-white' : 'text-fg-muted hover:text-fg'
                  )}
                >
                  {isActive && (
                    <motion.div
                      layoutId="top-tab-indicator"
                      className="absolute inset-0 bg-accent-600 rounded-md"
                      transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
                    />
                  )}
                  <span className="relative z-10">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <SettingsModalOpenButton />
          {sandboxRunning && (
            <IconButton aria-label="Stop sandbox" icon={<PiStopFill />} size="sm" onClick={stopSandbox} />
          )}
          {chatRunning && <IconButton aria-label="Stop chat" icon={<PiStopFill />} size="sm" onClick={stopChat} />}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {store.layoutMode === 'chat' ? <Chat /> : store.layoutMode === 'fleet' ? <Fleet /> : <Omni />}
      </div>
    </div>
  );
});
MainContent.displayName = 'MainContent';
