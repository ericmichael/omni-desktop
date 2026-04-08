import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { PiGearFill } from 'react-icons/pi';

import { Sidebar } from '@/renderer/app/Sidebar';
import { cn } from '@/renderer/ds';
import { Chat } from '@/renderer/features/Chat/Chat';
import { Code } from '@/renderer/features/Code/Code';
import { Tickets } from '@/renderer/features/Tickets/Tickets';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { $isSettingsOpen } from '@/renderer/features/SettingsModal/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const MorePage = memo(() => {
  const openSettings = useCallback(() => {
    $isSettingsOpen.set(true);
  }, []);

  return (
    <div className="flex flex-col w-full h-full bg-surface">
      <div className="px-4 py-3 border-b border-surface-border">
        <h1 className="text-base font-semibold text-fg">More</h1>
      </div>
      <div className="flex flex-col py-2">
        <button
          type="button"
          onClick={openSettings}
          className="flex items-center gap-3 px-4 py-3 text-left text-fg hover:bg-white/5 transition-colors"
        >
          <PiGearFill size={20} className="text-fg-muted" />
          <span className="text-sm">Settings</span>
        </button>
      </div>
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
