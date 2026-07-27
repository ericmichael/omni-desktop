import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Chat24Filled,
  Chat24Regular,
  Home24Filled,
  Home24Regular,
  PeopleTeam24Filled,
  PeopleTeam24Regular,
  Settings24Filled,
  Settings24Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { KeyboardEvent } from 'react';
import { memo, useCallback, useRef } from 'react';

import { $mobileHomeOpen } from '@/renderer/app/mobile-home';
import { CounterBadge } from '@/renderer/ds';
import { $activeInboxCount } from '@/renderer/features/Inbox/state';
import { $activityUnread, $residentsView, goToActivity } from '@/renderer/features/Residents/state';
import { $needsYouCount } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';

/**
 * The MOBILE bottom tab bar — the Slack mobile model. Home shows the
 * unified sidebar as a full-screen page (every surface opens from it, and
 * the bar is always there to come back); Deck and Activity are the two
 * live surfaces worth one-tap access; Settings is convention. Everything
 * else (Work, projects, channels, DMs, Agents, Routines, Plugins,
 * Dashboards) is reached through Home. Desktop hides this bar entirely.
 */

/** Content height of the mobile bottom tab bar (excludes the safe-area
 *  padding below it): 8px pad + 24px icon + 4px gap + 12px label + 8px pad.
 *  Fixed-position surfaces that must clear the nav (e.g. SyncBar) offset by
 *  this plus env(safe-area-inset-bottom). */
export const BOTTOM_NAV_MOBILE_HEIGHT = 56;

const useStyles = makeStyles({
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
      display: 'none',
    },
  },
  navGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  /* Branded bar — used by themes that set `header.bg` in fluent-themes.ts
     (currently just UTRGV). */
  navBranded: {
    backgroundColor: 'var(--color-header)',
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
    '& button[role="tab"] > div:first-child': {
      backgroundColor: '#ffffff',
    },
  },
  items: {
    display: 'flex',
    flexDirection: 'row',
    flex: '1 1 0',
    justifyContent: 'space-evenly',
  },
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
  },
  itemActive: {
    color: tokens.colorNeutralForeground1,
  },
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
});

export const Sidebar = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const residentsView = useStore($residentsView);
  const homeOpen = useStore($mobileHomeOpen);
  const inboxCount = useStore($activeInboxCount);
  const needsYouCount = useStore($needsYouCount);
  const activityUnread = useStore($activityUnread);
  const isGlass = useStore($glassEnabled);
  const isBrandedRail = store.theme === 'utrgv' && !isGlass;

  const handleHome = useCallback(() => $mobileHomeOpen.set(true), []);
  const handleDeck = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'chat');
    $mobileHomeOpen.set(false);
  }, []);
  const handleActivity = useCallback(() => {
    goToActivity();
    $mobileHomeOpen.set(false);
  }, []);
  const handleSettings = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'settings');
    $mobileHomeOpen.set(false);
  }, []);

  const mode = store.layoutMode;
  const activityOpen =
    mode === 'agents' &&
    residentsView.selectedAgentId === null &&
    residentsView.selectedChannel === null &&
    residentsView.showHandbook !== true &&
    residentsView.showRoster !== true &&
    residentsView.showRoutines !== true &&
    residentsView.showNewAgent !== true;

  // Home's badge is the attention the Home page's rows carry (inbox +
  // needs-you); Activity carries its own unread.
  const homeBadge = inboxCount + needsYouCount;

  const tabs: {
    value: string;
    label: string;
    icon: React.ReactNode;
    iconActive: React.ReactNode;
    active: boolean;
    badge: number;
    onClick: () => void;
  }[] = [
    {
      value: 'home',
      label: 'Home',
      icon: <Home24Regular />,
      iconActive: <Home24Filled />,
      active: homeOpen,
      badge: homeOpen ? 0 : homeBadge,
      onClick: handleHome,
    },
    {
      value: 'deck',
      label: 'Deck',
      icon: <Chat24Regular />,
      iconActive: <Chat24Filled />,
      active: !homeOpen && mode === 'chat',
      badge: 0,
      onClick: handleDeck,
    },
    {
      value: 'activity',
      label: 'Activity',
      icon: <PeopleTeam24Regular />,
      iconActive: <PeopleTeam24Filled />,
      active: !homeOpen && activityOpen,
      badge: !homeOpen && activityOpen ? 0 : activityUnread,
      onClick: handleActivity,
    },
    {
      value: 'settings',
      label: 'Settings',
      icon: <Settings24Regular />,
      iconActive: <Settings24Filled />,
      active: !homeOpen && mode === 'settings',
      badge: 0,
      onClick: handleSettings,
    },
  ];

  // Arrow-key navigation within the tab bar.
  const navRef = useRef<HTMLElement>(null);
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const nav = navRef.current;
    if (!nav) {
      return;
    }
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
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

  return (
    <nav
      ref={navRef}
      className={mergeClasses(styles.nav, isGlass && styles.navGlass, isBrandedRail && styles.navBranded)}
      role="tablist"
      aria-label="Main navigation"
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
    >
      <div className={styles.items}>
        {tabs.map((tab) => (
          <button
            key={tab.value}
            role="tab"
            aria-selected={tab.active}
            tabIndex={tab.active ? 0 : -1}
            type="button"
            onClick={tab.onClick}
            className={mergeClasses(styles.item, tab.active && styles.itemActive)}
          >
            {tab.active && <div className={styles.indicator} />}
            <span className={styles.iconWrap}>
              {tab.active ? tab.iconActive : tab.icon}
              {tab.badge > 0 && <CounterBadge count={tab.badge} size="small" color="brand" className={styles.badge} />}
            </span>
            <span className={styles.itemLabel}>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
});
Sidebar.displayName = 'Sidebar';
