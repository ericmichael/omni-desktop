import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo } from 'react';
import { PiChatCircleFill, PiCodeBold, PiGearFill, PiHammerFill, PiRocketLaunchFill } from 'react-icons/pi';

import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { cn, IconButton } from '@/renderer/ds';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const ALL_TABS: { value: LayoutMode; label: string; icon: React.ReactNode }[] = [
  { value: 'chat', label: 'Chat', icon: <PiChatCircleFill size={20} /> },
  { value: 'work', label: 'Work', icon: <PiHammerFill size={20} /> },
  { value: 'code', label: 'Code', icon: <PiCodeBold size={20} /> },
  { value: 'fleet', label: 'Fleet', icon: <PiRocketLaunchFill size={20} /> },
];

const activeTabForMode = (mode: LayoutMode): LayoutMode => {
  if (mode === 'desktop') {
    return 'code';
  }
  return mode;
};

const springTransition = { type: 'spring', duration: 0.3, bounce: 0.15 } as const;

export const Sidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const isSettingsOpen = useStore($isSettingsOpen);

  const setMode = useCallback(
    (mode: LayoutMode) => () => {
      persistedStoreApi.setKey('layoutMode', mode);
    },
    []
  );

  const openSettings = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);

  const visibleTabs = useMemo(
    () =>
      import.meta.env.MODE === 'development'
        ? ALL_TABS
        : ALL_TABS.filter((t) => t.value !== 'fleet' && t.value !== 'work' && t.value !== 'code'),
    []
  );

  const activeTab = activeTabForMode(store.layoutMode);

  return (
    <nav className="flex flex-col w-[68px] shrink-0 h-full bg-header border-r border-header-border">
      {/* Logo */}
      <div className="grid place-items-center py-3 border-b border-header-border">
        <OmniLogo className="translate-y-px" />
      </div>

      {/* Nav items */}
      <div className="flex flex-col py-1">
        {visibleTabs.map((tab) => {
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={setMode(tab.value)}
              className={cn(
                'relative flex flex-col items-center justify-center gap-0.5 py-2.5 cursor-pointer select-none transition-colors',
                isActive ? 'text-header-fg' : 'text-fg-muted hover:text-header-fg hover:bg-white/5'
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active-indicator"
                  className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent-600 rounded-r-full"
                  transition={springTransition}
                />
              )}
              {isActive && (
                <motion.div
                  layoutId="sidebar-active-bg"
                  className="absolute inset-1 rounded-md bg-white/10"
                  transition={springTransition}
                />
              )}
              <span className="relative z-10">{tab.icon}</span>
              <span className="relative z-10 text-[10px] leading-tight">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom section */}
      <div className="flex flex-col items-center gap-1 py-2 border-t border-header-border">
        <IconButton
          aria-label="Settings"
          icon={<PiGearFill />}
          size="sm"
          onClick={openSettings}
          isDisabled={isSettingsOpen}
        />
      </div>
    </nav>
  );
});
Sidebar.displayName = 'Sidebar';
