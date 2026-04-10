import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { PiGearFill, PiInfoBold, PiTerminalBold } from 'react-icons/pi';

import { Sidebar } from '@/renderer/app/Sidebar';
import { cn, ListItem } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { Chat } from '@/renderer/features/Chat/Chat';
import { Code } from '@/renderer/features/Code/Code';
import { $isConsoleOpen } from '@/renderer/features/Console/state';
import { Dashboards } from '@/renderer/features/Dashboards/Dashboards';
import { RightNow } from '@/renderer/features/RightNow/RightNow';
import { Tickets } from '@/renderer/features/Tickets/Tickets';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const MorePage = memo(() => {
  const version = useStore($launcherVersion);

  const openSettings = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);

  const openConsole = useCallback(() => {
    $isConsoleOpen.set(true);
  }, []);

  return (
    <div className="flex flex-col w-full h-full bg-surface">
      <div className="px-5 pt-6 pb-4">
        <h1 className="text-2xl font-bold text-fg tracking-tight">More</h1>
      </div>
      <div className="flex flex-col">
        <ListItem icon={<PiGearFill size={20} />} label="Settings" detail="Theme, models, network, MCP" onClick={openSettings} />
        <ListItem icon={<PiTerminalBold size={20} />} label="Dev Console" detail="Terminal session" onClick={openConsole} />
      </div>
      {version && (
        <div className="mt-auto px-5 py-6">
          <div className="flex items-center gap-2.5 text-fg-subtle">
            <PiInfoBold size={14} />
            <span className="text-xs">Omni Code Launcher v{version}</span>
          </div>
        </div>
      )}
    </div>
  );
});
MorePage.displayName = 'MorePage';

/**
 * Lazy-mount, never-unmount layout.
 *
 * Each component mounts the first time its tab is visited and stays mounted
 * thereafter (hidden via CSS `display:none`). This preserves webview state,
 * Docker container connections, and component state across tab switches.
 */
export const MainContent = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const active: LayoutMode = store.layoutMode;

  // Track which component keys have been visited so we mount lazily but never unmount.
  const [mounted, setMounted] = useState<Set<LayoutMode>>(() => new Set([active]));

  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(active)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(active);
      return next;
    });
  }, [active]);

  if (!store.onboardingComplete) {
    return <OnboardingWizard />;
  }

  return (
    <div className="flex flex-col-reverse sm:flex-row w-full h-full">
      <Sidebar />
      <div className="flex-1 min-w-0 min-h-0 relative">
        {mounted.has('home') && (
          <div className={cn('w-full h-full', active !== 'home' && 'hidden')}>
            <RightNow />
          </div>
        )}
        {mounted.has('chat') && (
          <div className={cn('w-full h-full', active !== 'chat' && 'hidden')}>
            <Chat />
          </div>
        )}
        {mounted.has('code') && (
          <div className={cn('w-full h-full', active !== 'code' && 'hidden')}>
            <Code />
          </div>
        )}
        {mounted.has('projects') && (
          <div className={cn('w-full h-full', active !== 'projects' && 'hidden')}>
            <Tickets />
          </div>
        )}
        {mounted.has('dashboards') && (
          <div className={cn('w-full h-full', active !== 'dashboards' && 'hidden')}>
            <Dashboards />
          </div>
        )}
        {mounted.has('more') && (
          <div className={cn('w-full h-full', active !== 'more' && 'hidden')}>
            <MorePage />
          </div>
        )}
      </div>
    </div>
  );
});
MainContent.displayName = 'MainContent';
