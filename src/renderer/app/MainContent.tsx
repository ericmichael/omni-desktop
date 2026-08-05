import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { AppSidebar } from '@/renderer/app/AppSidebar';
import { cn } from '@/renderer/ds/cn';
import { SidebarInset, SidebarProvider } from '@/renderer/ds/ui/sidebar';
import { Code } from '@/renderer/features/Code/Code';
import { Dashboards } from '@/renderer/features/Dashboards/Dashboards';
import { Gallery } from '@/renderer/features/Gallery/Gallery';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { PluginsView } from '@/renderer/features/Plugins/PluginsView';
import { ResidentsTab } from '@/renderer/features/Residents/ResidentsTab';
import { SandboxesTabContent } from '@/renderer/features/Sandboxes/SandboxesTabContent';
import { SettingsPage } from '@/renderer/features/SettingsModal/SettingsPage';
import { Tickets } from '@/renderer/features/Tickets/Tickets';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const SIDEBAR_OPEN_STORAGE_KEY = 'omni.sidebarOpen';

function loadSidebarOpen(): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (stored !== null) {
      return stored !== 'false';
    }
    const cookie = document.cookie
      .split('; ')
      .find((entry) => entry.startsWith('sidebar_state='))
      ?.split('=')[1];
    return cookie === undefined ? true : cookie === 'true';
  } catch {
    return true;
  }
}

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
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open);
    try {
      localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open));
    } catch {
      /* Ignore unavailable renderer storage. */
    }
  }, []);
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

  const panels: { key: LayoutMode; Component: React.ComponentType }[] = [
    // Work owns the inbox, projects, tasks, pages, and milestones.
    { key: 'work', Component: Tickets },
    // Chat IS the deck since the tab merge: chat columns and work sessions
    // share one surface (Spaces/Focus), so there's a single panel for both.
    { key: 'chat', Component: Code },
    { key: 'dashboards', Component: Dashboards },
    // Agents hosts the resident roster, channels/DMs, and the Routines surface.
    { key: 'agents', Component: ResidentsTab },
    { key: 'plugins', Component: PluginsView },
    { key: 'sandboxes', Component: SandboxesTabContent },
    { key: 'settings', Component: SettingsPage },
    ...(import.meta.env.DEV ? [{ key: 'gallery' as const, Component: Gallery }] : []),
  ];

  return (
    <div className="flex size-full flex-row">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={handleSidebarOpenChange}
        className="app-sidebar-provider h-full min-h-0!"
      >
        {/* Stock shadcn Sidebar owns both the persistent desktop column and
            the mobile Sheet. One provider means every trigger controls the
            same sidebar state. */}
        <AppSidebar />
        <SidebarInset className="relative min-h-0 min-w-0 flex-1">
          {panels.map(
            ({ key, Component }) =>
              mounted.has(key) && (
                <div key={key} className={cn('size-full', active !== key && 'hidden')}>
                  <Component />
                </div>
              )
          )}
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
});
MainContent.displayName = 'MainContent';
