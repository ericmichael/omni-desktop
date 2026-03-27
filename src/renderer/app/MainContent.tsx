import { useStore } from '@nanostores/react';
import { memo, useEffect, useState } from 'react';

import { Sidebar } from '@/renderer/app/Sidebar';
import { cn } from '@/renderer/ds';
import { Chat } from '@/renderer/features/Chat/Chat';
import { Code } from '@/renderer/features/Code/Code';
import { Fleet } from '@/renderer/features/Fleet/Fleet';
import { Omni } from '@/renderer/features/Omni/Omni';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

/** Map layoutMode to the component key that handles it. work/desktop both use Omni. */
const componentForMode = (mode: LayoutMode): string => {
  if (mode === 'chat') {
    return 'chat';
  }
  if (mode === 'fleet') {
    return 'fleet';
  }
  if (mode === 'code') {
    return 'code';
  }
  return 'omni'; // work, desktop
};

/**
 * Lazy-mount, never-unmount layout.
 *
 * Each component mounts the first time its tab is visited and stays mounted
 * thereafter (hidden via CSS `display:none`). This preserves webview state,
 * Docker container connections, and component state across tab switches.
 */
export const MainContent = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const active = componentForMode(store.layoutMode);

  // Track which component keys have been visited so we mount lazily but never unmount.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([active]));

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
    <div className="flex w-full h-full">
      <Sidebar />
      <div className="flex-1 min-w-0 min-h-0 relative">
        {mounted.has('chat') && (
          <div className={cn('w-full h-full', active !== 'chat' && 'hidden')}>
            <Chat />
          </div>
        )}
        {mounted.has('omni') && (
          <div className={cn('w-full h-full', active !== 'omni' && 'hidden')}>
            <Omni />
          </div>
        )}
        {mounted.has('code') && (
          <div className={cn('w-full h-full', active !== 'code' && 'hidden')}>
            <Code />
          </div>
        )}
        {mounted.has('fleet') && (
          <div className={cn('w-full h-full', active !== 'fleet' && 'hidden')}>
            <Fleet />
          </div>
        )}
      </div>
    </div>
  );
});
MainContent.displayName = 'MainContent';
