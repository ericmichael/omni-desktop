import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo } from 'react';
import {
  PiChatCircleFill,
  PiChartBarBold,
  PiCodeBold,
  PiDotsThreeBold,
  PiGearFill,
  PiRocketLaunchFill,
} from 'react-icons/pi';

import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { cn } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const ALL_TABS: { value: LayoutMode; label: string; icon: React.ReactNode; enterprise?: boolean }[] = [
  { value: 'chat', label: 'Chat', icon: <PiChatCircleFill size={20} /> },
  { value: 'code', label: 'Code', icon: <PiCodeBold size={20} /> },
  { value: 'projects', label: 'Projects', icon: <PiRocketLaunchFill size={20} /> },
  { value: 'dashboards', label: 'Dashboards', icon: <PiChartBarBold size={20} />, enterprise: true },
];

const springTransition = { type: 'spring', duration: 0.3, bounce: 0.15 } as const;

export const Sidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const isSettingsOpen = useStore($isSettingsOpen);
  const inboxItems = useStore($inboxItems);
  const openInboxCount = useMemo(
    () => Object.values(inboxItems).filter((i) => i.status === 'open').length,
    [inboxItems]
  );

  const setMode = useCallback(
    (mode: LayoutMode) => () => {
      persistedStoreApi.setKey('layoutMode', mode);
    },
    []
  );

  const openSettings = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);

  const hasPlatform = Boolean(store.platform?.accessToken);
  const visibleTabs = useMemo(
    () => {
      return ALL_TABS.filter((t) => {
        // Enterprise tabs: only when authenticated to platform
        if (t.enterprise) return hasPlatform;
        // Preview tabs (Code, Projects): dev mode or preview features enabled
        if (t.value !== 'chat') return import.meta.env.MODE === 'development' || store.previewFeatures;
        // Chat: always visible
        return true;
      });
    },
    [store.previewFeatures, hasPlatform]
  );

  const activeTab = store.layoutMode;

  return (
    <nav className="flex flex-row sm:flex-col w-full sm:w-[68px] shrink-0 h-auto sm:h-full bg-header border-t sm:border-t-0 sm:border-r border-header-border pb-[env(safe-area-inset-bottom,0px)] sm:pb-0">
      {/* Logo — hidden on mobile */}
      <div className="hidden sm:grid place-items-center py-3 border-b border-header-border">
        <OmniLogo className="translate-y-px" />
      </div>

      {/* Nav items — flat row on mobile so all items (including settings) space evenly */}
      <div className="contents sm:flex sm:flex-col sm:flex-1">
        <div className="flex flex-row sm:flex-col flex-1 sm:flex-initial justify-evenly sm:justify-start py-0 sm:py-1">
          {visibleTabs.map((tab) => {
            const isActive = activeTab === tab.value;
            return (
              <button
                key={tab.value}
                onClick={setMode(tab.value)}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-0.5 py-2 sm:py-2.5 flex-1 sm:flex-initial cursor-pointer select-none transition-colors',
                  isActive ? 'text-header-fg' : 'text-fg-muted hover:text-header-fg hover:bg-white/5'
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="sidebar-active-indicator"
                    className="absolute bottom-0 left-2 right-2 h-[3px] sm:bottom-auto sm:left-0 sm:top-1 sm:right-auto sm:h-auto sm:bottom-1 sm:w-[3px] bg-accent-600 rounded-t-full sm:rounded-t-none sm:rounded-r-full"
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
                <span className="relative z-10">
                  {tab.icon}
                  {tab.value === 'projects' && openInboxCount > 0 && (
                    <span className="absolute -top-1 -right-2 min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold leading-[18px] text-center bg-accent-600 text-white">
                      {openInboxCount}
                    </span>
                  )}
                </span>
                <span className="relative z-10 text-xs leading-tight">{tab.label}</span>
              </button>
            );
          })}

          {/* More — mobile only, opens a page with Settings etc. */}
          <button
            onClick={setMode('more')}
            className={cn(
              'relative flex flex-col items-center justify-center gap-0.5 py-2 flex-1 sm:hidden cursor-pointer select-none transition-colors',
              activeTab === 'more' ? 'text-header-fg' : 'text-fg-muted hover:text-header-fg hover:bg-white/5'
            )}
          >
            {activeTab === 'more' && (
              <motion.div
                layoutId="sidebar-active-indicator"
                className="absolute bottom-0 left-2 right-2 h-[3px] bg-accent-600 rounded-t-full"
                transition={springTransition}
              />
            )}
            {activeTab === 'more' && (
              <motion.div
                layoutId="sidebar-active-bg"
                className="absolute inset-1 rounded-md bg-white/10"
                transition={springTransition}
              />
            )}
            <span className="relative z-10">
              <PiDotsThreeBold size={20} />
            </span>
            <span className="relative z-10 text-xs leading-tight">More</span>
          </button>
        </div>

        {/* Spacer — desktop only */}
        <div className="hidden sm:block flex-1" />

        {/* Settings — desktop only, pinned to bottom */}
        <div className="hidden sm:block sm:border-t border-header-border">
          <button
            onClick={openSettings}
            disabled={isSettingsOpen}
            className={cn(
              'relative flex flex-col items-center justify-center gap-0.5 py-2.5 w-full cursor-pointer select-none transition-colors',
              isSettingsOpen
                ? 'text-header-fg opacity-40 pointer-events-none'
                : 'text-fg-muted hover:text-header-fg hover:bg-white/5'
            )}
          >
            <span className="relative z-10">
              <PiGearFill size={20} />
            </span>
            <span className="relative z-10 text-xs leading-tight">Settings</span>
          </button>
        </div>
      </div>
    </nav>
  );
});
Sidebar.displayName = 'Sidebar';
