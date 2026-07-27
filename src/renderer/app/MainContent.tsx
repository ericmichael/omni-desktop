import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useEffect, useState } from 'react';

import { AppSidebar } from '@/renderer/app/AppSidebar';
import { $mobileHomeOpen } from '@/renderer/app/mobile-home';
import { Sidebar } from '@/renderer/app/Sidebar';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
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
import { getThemeBackdrop, getThemeBuiltinGlassTone } from '@/renderer/theme/fluent-themes';
import { getGlassVars } from '@/renderer/theme/glass-vars';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { LayoutMode } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column-reverse',
    width: '100%',
    height: '100%',
    '@media (min-width: 640px)': {
      flexDirection: 'row',
    },
  },
  rootWithDeckBg: {
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  content: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
  },
  panel: {
    width: '100%',
    height: '100%',
  },
  hidden: {
    display: 'none',
  },
});

/**
 * Lazy-mount, never-unmount layout.
 *
 * Each component mounts the first time its tab is visited and stays mounted
 * thereafter (hidden via CSS `display:none`). This preserves webview state,
 * Docker container connections, and component state across tab switches.
 */
export const MainContent = memo(() => {
  const styles = useStyles();
  const isDesktop = useIsDesktop();
  const mobileHomeOpen = useStore($mobileHomeOpen);
  const store = useStore(persistedStoreApi.$atom);
  const active: LayoutMode = store.layoutMode;
  // Glass follows the THEME (one knob). The user's wallpaper, when set, only
  // overrides the glass theme's built-in backdrop — it never activates glass.
  const isGlass = useStore($glassEnabled);
  const theme = store.theme ?? 'omni';
  const userBackdrop = store.codeDeckBackground ?? null;
  const backdropStyle: React.CSSProperties | undefined = isGlass
    ? userBackdrop
      ? { backgroundImage: `url(${userBackdrop})` }
      : { background: getThemeBackdrop(theme) ?? undefined }
    : undefined;
  // User wallpapers carry their luminance-detected tone; the built-in
  // backdrop uses the theme's declared tone.
  const glassTone = userBackdrop ? (store.glassTone ?? 'dark') : getThemeBuiltinGlassTone(theme);

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
    // share one surface (Tile/Focus), so there's a single panel for both.
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
    <div
      className={mergeClasses(styles.root, isGlass && styles.rootWithDeckBg, isGlass && 'omni-glass')}
      style={
        isGlass
          ? {
              ...backdropStyle,
              ...getGlassVars(glassTone),
            }
          : undefined
      }
    >
      {/* Mobile bottom bar (self-hides ≥640px) + the unified sidebar —
          persistent nav on desktop, the Home page when open on mobile. */}
      <Sidebar />
      <AppSidebar />
      {/* Panels stay MOUNTED while the mobile Home page is frontmost —
          hidden, not unmounted, to preserve webview/session state. */}
      <div className={styles.content} style={!isDesktop && mobileHomeOpen ? { display: 'none' } : undefined}>
        {panels.map(
          ({ key, Component }) =>
            mounted.has(key) && (
              <div key={key} className={mergeClasses(styles.panel, active !== key && styles.hidden)}>
                <Component />
              </div>
            )
        )}
      </div>
    </div>
  );
});
MainContent.displayName = 'MainContent';
