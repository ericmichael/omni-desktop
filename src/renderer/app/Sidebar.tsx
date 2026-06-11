import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Beaker24Filled,
  Beaker24Regular,
  Chat24Filled,
  Chat24Regular,
  ColumnTriple24Filled,
  ColumnTriple24Regular,
  DataBarVertical24Filled,
  DataBarVertical24Regular,
  Rocket24Filled,
  Rocket24Regular,
  Settings24Filled,
  Settings24Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { CounterBadge } from '@/renderer/ds';
import { $activeInboxCount } from '@/renderer/features/Inbox/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { LayoutMode } from '@/shared/types';

/* Fluent rail idiom: Regular icon at rest, Filled only while selected. */
const ALL_TABS: {
  value: LayoutMode;
  label: string;
  icon: React.ReactNode;
  iconActive: React.ReactNode;
  enterprise?: boolean;
  alwaysVisible?: boolean;
  pinBottom?: boolean;
  devOnly?: boolean;
}[] = [
  { value: 'chat', label: 'Chat', icon: <Chat24Regular />, iconActive: <Chat24Filled />, alwaysVisible: true },
  {
    value: 'spaces',
    label: 'Spaces',
    icon: <ColumnTriple24Regular />,
    iconActive: <ColumnTriple24Filled />,
    alwaysVisible: true,
  },
  {
    value: 'projects',
    label: 'Projects',
    icon: <Rocket24Regular />,
    iconActive: <Rocket24Filled />,
    alwaysVisible: true,
  },
  {
    value: 'dashboards',
    label: 'Dashboards',
    icon: <DataBarVertical24Regular />,
    iconActive: <DataBarVertical24Filled />,
    enterprise: true,
  },
  { value: 'gallery', label: 'Gallery', icon: <Beaker24Regular />, iconActive: <Beaker24Filled />, devOnly: true },
  {
    value: 'settings',
    label: 'Settings',
    icon: <Settings24Regular />,
    iconActive: <Settings24Filled />,
    alwaysVisible: true,
    // Desktop pins Settings at the rail's bottom; the mobile bar shows it inline
    // as the fourth tab (the one-row "More" page is gone).
    pinBottom: true,
  },
];

/* Same 640px breakpoint the styles below use (and Tickets' DESKTOP_MQ). */
const DESKTOP_MQ = '(min-width: 640px)';
const subscribeDesktopMQ = (cb: () => void) => {
  const mql = window.matchMedia(DESKTOP_MQ);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};
const getIsDesktop = () => window.matchMedia(DESKTOP_MQ).matches;
const getIsDesktopServer = () => true;

/** Content height of the mobile bottom tab bar (excludes the safe-area
 *  padding below it): 8px pad + 24px icon + 4px gap + 12px label + 8px pad.
 *  Fixed-position surfaces that must clear the nav (e.g. SyncBar) offset by
 *  this plus env(safe-area-inset-bottom). */
export const BOTTOM_NAV_MOBILE_HEIGHT = 56;

const useStyles = makeStyles({
  /* ── Rail container ── */
  nav: {
    display: 'flex',
    flexDirection: 'row',
    width: '100%',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
    boxSizing: 'border-box',
    /* --safe-area-bottom is zeroed by use-app-height in the iOS-standalone
       short-viewport state, where the home indicator lies below the
       paintable viewport and the backstop band provides the clearance. */
    paddingBottom: 'var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))',
    '@media (min-width: 640px)': {
      flexDirection: 'column',
      width: '78px',
      height: '100%',
      borderTopWidth: '0',
      borderRightWidth: '1px',
      borderRightStyle: 'solid',
      borderRightColor: tokens.colorNeutralStroke1,
      paddingBottom: '0',
    },
  },
  navGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  /* Branded rail — used by themes that set `header.bg` in fluent-themes.ts
     (currently just UTRGV). Reads the same `--color-header` CSS var the
     branded header bar uses, and remaps icon/indicator colors to white
     for contrast against the brand fill. */
  navBranded: {
    backgroundColor: 'var(--color-header)',
    borderRightColor: 'rgba(255, 255, 255, 0.15)',
    borderTopColor: 'rgba(255, 255, 255, 0.15)',
    '& button[role="tab"]': {
      color: 'rgba(255, 255, 255, 0.75)',
      ':hover': {
        color: '#ffffff',
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
      },
    },
    '& button[role="tab"][aria-selected="true"]': {
      color: '#ffffff',
      backgroundColor: 'rgba(255, 255, 255, 0.15)',
    },
    /* Indicator: brand color is the bg fill, so use white so it's visible. */
    '& button[role="tab"] > div:first-child': {
      backgroundColor: '#ffffff',
    },
  },

  /* ── Logo (desktop only) ── */
  logo: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      paddingTop: '24px',
      paddingBottom: '16px',
    },
  },

  /* ── Tab list ── */
  items: {
    display: 'flex',
    flexDirection: 'row',
    flex: '1 1 0',
    justifyContent: 'space-evenly',
    '@media (min-width: 640px)': {
      flexDirection: 'column',
      flex: '0 0 auto',
      alignItems: 'center',
      gap: '2px',
      paddingTop: '8px',
    },
  },

  /* ── Single nav item ── */
  item: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    paddingTop: '8px',
    paddingBottom: '8px',
    flex: '1 1 0',
    cursor: 'pointer',
    userSelect: 'none',
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground3,
    borderRadius: '0',
    transitionProperty: 'color, background-color',
    transitionDuration: '100ms',
    transitionTimingFunction: 'ease',
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
      borderRadius: tokens.borderRadiusMedium,
    },
    '@media (min-width: 640px)': {
      flex: '0 0 auto',
      width: '100%',
      borderRadius: '0',
      paddingTop: '10px',
      paddingBottom: '8px',
      ':hover': {
        backgroundColor: tokens.colorSubtleBackgroundHover,
        color: tokens.colorNeutralForeground1,
      },
    },
  },
  itemActive: {
    color: tokens.colorNeutralForeground1,
    '@media (min-width: 640px)': {
      backgroundColor: tokens.colorSubtleBackgroundSelected,
    },
  },

  /* ── Active indicator bar ── */
  indicator: {
    position: 'absolute',
    /* The nav reserves the bottom safe area via its own paddingBottom, so the
       buttons (and this indicator) already sit above the home indicator —
       don't add the inset again here. */
    bottom: '0',
    left: '25%',
    right: '25%',
    height: '3px',
    backgroundColor: tokens.colorBrandForeground1,
    borderTopLeftRadius: tokens.borderRadiusCircular,
    borderTopRightRadius: tokens.borderRadiusCircular,
    '@media (min-width: 640px)': {
      top: '8px',
      bottom: '8px',
      left: '0',
      right: 'auto',
      width: '3px',
      height: 'auto',
      borderTopLeftRadius: '0',
      borderTopRightRadius: tokens.borderRadiusCircular,
      borderBottomRightRadius: tokens.borderRadiusCircular,
    },
  },

  itemLabel: {
    fontSize: '0.75rem',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '1',
  },
  iconWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '> svg': {
      width: '24px',
      height: '24px',
    },
  },
  badge: {
    position: 'absolute',
    top: '-6px',
    right: '-10px',
  },

  /* ── Inline rendering of bottom-pinned tabs (mobile bar only) ── */
  mobileOnlyItem: {
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },

  /* ── Spacer + Settings (desktop only) ── */
  spacer: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'block',
      flex: '1 1 0',
    },
  },
  settingsWrap: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'flex',
      justifyContent: 'center',
      paddingBottom: '12px',
    },
  },
});

export const Sidebar = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const openInboxCount = useStore($activeInboxCount);
  const isGlass = useStore($glassEnabled);
  const isBrandedRail = store.theme === 'utrgv' && !isGlass;

  const setMode = useCallback(
    (mode: LayoutMode) => () => {
      persistedStoreApi.setKey('layoutMode', mode);
      if (mode === 'projects') {
        ticketApi.goToDashboard();
      }
    },
    []
  );

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const visibleTabs = useMemo(() => {
    return ALL_TABS.filter((t) => {
      if (t.devOnly) {
        return import.meta.env.DEV;
      }
      if (t.alwaysVisible) {
        return true;
      }
      if (t.enterprise) {
        return isEnterprise;
      }
      return true;
    });
  }, [isEnterprise]);

  const topTabs = useMemo(() => visibleTabs.filter((t) => !t.pinBottom), [visibleTabs]);
  const bottomTabs = useMemo(() => visibleTabs.filter((t) => t.pinBottom), [visibleTabs]);

  const activeTab = store.layoutMode;

  // Arrow-key navigation within the tab rail. Only visible tabs participate —
  // Settings renders twice (inline for the mobile bar, pinned for the desktop
  // rail) with one of the two always display:none.
  const navRef = useRef<HTMLElement>(null);
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).filter(
      (b) => b.offsetParent !== null
    );
    const current = buttons.indexOf(e.target as HTMLButtonElement);
    if (current === -1) {
      return;
    }

    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      next = (current + 1) % buttons.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      next = (current - 1 + buttons.length) % buttons.length;
    } else if (e.key === 'Home') {
      next = 0;
    } else if (e.key === 'End') {
      next = buttons.length - 1;
    }

    if (next !== -1) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  }, []);

  // The rail is a column on desktop and a bottom bar on mobile — keep the
  // announced orientation in sync with the rendered one.
  const isDesktop = useSyncExternalStore(subscribeDesktopMQ, getIsDesktop, getIsDesktopServer);

  // No Tooltip wrapper: the rail always shows the label under each icon, so a
  // tooltip is redundant — and it stuck open over content on touch/tap.
  const renderTab = (tab: (typeof ALL_TABS)[number], extraClass?: string) => {
    const isActive = activeTab === tab.value;
    return (
      <button
        key={tab.value}
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        type="button"
        onClick={setMode(tab.value)}
        className={mergeClasses(styles.item, isActive && styles.itemActive, extraClass)}
      >
        {isActive && <div className={styles.indicator} />}
        <span className={styles.iconWrap}>
          {isActive ? tab.iconActive : tab.icon}
          {tab.value === 'projects' && openInboxCount > 0 && (
            <CounterBadge count={openInboxCount} size="small" color="brand" className={styles.badge} />
          )}
        </span>
        <span className={styles.itemLabel}>{tab.label}</span>
      </button>
    );
  };

  return (
    <nav
      ref={navRef}
      className={mergeClasses(styles.nav, isGlass && styles.navGlass, isBrandedRail && styles.navBranded)}
      role="tablist"
      aria-label="Main navigation"
      aria-orientation={isDesktop ? 'vertical' : 'horizontal'}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.logo}>
        <OmniLogo />
      </div>

      <div className={styles.items}>
        {topTabs.map((tab) => renderTab(tab))}

        {/* Bottom-pinned tabs render inline in the mobile bar… */}
        {bottomTabs.map((tab) => renderTab(tab, styles.mobileOnlyItem))}
      </div>

      <div className={styles.spacer} />

      {/* …and pinned to the rail's bottom on desktop. */}
      <div className={styles.settingsWrap}>{bottomTabs.map((tab) => renderTab(tab))}</div>
    </nav>
  );
});
Sidebar.displayName = 'Sidebar';
