import { makeStyles, mergeClasses, tokens,Tooltip } from '@fluentui/react-components';
import {
  Chat24Filled,
  Code24Regular,
  DataBarVertical24Regular,
  MoreHorizontal24Filled,
  Rocket24Filled,
  Settings24Filled,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { CounterBadge } from '@/renderer/ds';
import { $activeInboxCount } from '@/renderer/features/Inbox/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

const ALL_TABS: {
  value: LayoutMode;
  label: string;
  icon: React.ReactNode;
  enterprise?: boolean;
  alwaysVisible?: boolean;
  pinBottom?: boolean;
}[] = [
  { value: 'chat', label: 'Chat', icon: <Chat24Filled />, alwaysVisible: true },
  { value: 'code', label: 'Code', icon: <Code24Regular />, alwaysVisible: true },
  { value: 'projects', label: 'Projects', icon: <Rocket24Filled />, alwaysVisible: true },
  { value: 'dashboards', label: 'Dashboards', icon: <DataBarVertical24Regular />, enterprise: true },
  { value: 'settings', label: 'Settings', icon: <Settings24Filled />, alwaysVisible: true, pinBottom: true },
];

const useStyles = makeStyles({
  /* ── Rail container ── */
  nav: {
    display: 'flex',
    flexDirection: 'row',
    width: '100%',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke1,
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
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
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    borderRightColor: 'rgba(255, 255, 255, 0.14)',
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
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
    fontSize: '12px',
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

  /* ── More button (mobile only) ── */
  moreItem: {
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
  const isGlass = (store.layoutMode === 'code' || store.layoutMode === 'chat' || store.layoutMode === 'settings' || store.layoutMode === 'projects') && !!store.codeDeckBackground;

  const setMode = useCallback(
    (mode: LayoutMode) => () => persistedStoreApi.setKey('layoutMode', mode),
    []
  );

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);

  const visibleTabs = useMemo(() => {
    return ALL_TABS.filter((t) => {
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

  // Arrow-key navigation within the tab rail
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

  const renderTab = (tab: (typeof ALL_TABS)[number], extraClass?: string) => {
    const isActive = activeTab === tab.value;
    return (
      <Tooltip key={tab.value} content={tab.label} relationship="label" positioning="after">
        <button
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          type="button"
          onClick={setMode(tab.value)}
          className={mergeClasses(styles.item, isActive && styles.itemActive, extraClass)}
        >
          {isActive && <div className={styles.indicator} />}
          <span className={styles.iconWrap}>
            {tab.icon}
            {tab.value === 'projects' && openInboxCount > 0 && (
              <CounterBadge count={openInboxCount} size="small" color="brand" className={styles.badge} />
            )}
          </span>
          <span className={styles.itemLabel}>{tab.label}</span>
        </button>
      </Tooltip>
    );
  };

  return (
    <nav
      ref={navRef}
      className={mergeClasses(styles.nav, isGlass && styles.navGlass)}
      role="tablist"
      aria-label="Main navigation"
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
    >
      <div className={styles.logo}>
        <OmniLogo />
      </div>

      <div className={styles.items}>
        {topTabs.map((tab) => renderTab(tab))}

        {/* More — mobile only */}
        {renderTab(
          { value: 'more', label: 'More', icon: <MoreHorizontal24Filled />, alwaysVisible: true },
          styles.moreItem
        )}
      </div>

      <div className={styles.spacer} />

      {/* Bottom-pinned tabs (Settings) — desktop only */}
      <div className={styles.settingsWrap}>
        {bottomTabs.map((tab) => renderTab(tab))}
      </div>
    </nav>
  );
});
Sidebar.displayName = 'Sidebar';
