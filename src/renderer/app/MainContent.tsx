import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Info20Regular, Settings20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Sidebar } from '@/renderer/app/Sidebar';
import { getGlassVars } from '@/renderer/theme/glass-vars';
import { Caption1, ListItem, Subtitle2 } from '@/renderer/ds';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { Chat } from '@/renderer/features/Chat/Chat';
import { Code } from '@/renderer/features/Code/Code';
import { Dashboards } from '@/renderer/features/Dashboards/Dashboards';
import { Gallery } from '@/renderer/features/Gallery/Gallery';
import { OnboardingWizard } from '@/renderer/features/Onboarding/OnboardingWizard';
import { SettingsPage } from '@/renderer/features/SettingsModal/SettingsPage';
import { Tickets } from '@/renderer/features/Tickets/Tickets';
import { persistedStoreApi } from '@/renderer/services/store';
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
  /** Hide the sidebar (bottom tab bar) on mobile when the code tab owns the bottom dock */
  sidebarHiddenMobile: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'contents',
    },
  },
  panel: {
    width: '100%',
    height: '100%',
  },
  hidden: {
    display: 'none',
  },
  morePage: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  morePageGlass: {
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  moreHeader: {
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '24px',
    paddingBottom: '16px',
  },
  moreFooter: {
    marginTop: 'auto',
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '24px',
    paddingBottom: '24px',
  },
  moreVersion: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    color: tokens.colorNeutralForeground3,
  },
});

const MorePage = memo(() => {
  const styles = useStyles();
  const version = useStore($launcherVersion);
  const isGlass = useStore(persistedStoreApi.$atom).codeDeckBackground != null;

  const openSettings = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'settings');
  }, []);

  return (
    <div className={mergeClasses(styles.morePage, isGlass && styles.morePageGlass)}>
      <div className={styles.moreHeader}>
        <Subtitle2>More</Subtitle2>
      </div>
      <div>
        <ListItem icon={<Settings20Filled />} label="Settings" detail="Theme, models, network, MCP" onClick={openSettings} />
      </div>
      {version && (
        <div className={styles.moreFooter}>
          <div className={styles.moreVersion}>
            <Info20Regular style={{ width: 14, height: 14 }} />
            <Caption1>Omni Code Launcher v{version}</Caption1>
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
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const active: LayoutMode = store.layoutMode;
  const deckBackground = store.codeDeckBackground ?? null;
  const showDeckBg = !!deckBackground;

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
    { key: 'chat', Component: Chat },
    { key: 'code', Component: Code },
    { key: 'projects', Component: Tickets },
    { key: 'dashboards', Component: Dashboards },
    { key: 'settings', Component: SettingsPage },
    { key: 'more', Component: MorePage },
    ...(import.meta.env.DEV ? [{ key: 'gallery' as const, Component: Gallery }] : []),
  ];

  return (
    <div
      className={mergeClasses(styles.root, showDeckBg && styles.rootWithDeckBg)}
      style={
        showDeckBg
          ? {
              backgroundImage: `url(${deckBackground})`,
              ...getGlassVars(store.glassTone ?? 'dark'),
            }
          : undefined
      }
    >
      <div className={mergeClasses(active === 'code' && styles.sidebarHiddenMobile)}>
        <Sidebar />
      </div>
      <div className={styles.content}>
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
