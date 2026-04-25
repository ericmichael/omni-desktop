import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { Apps20Regular, Cube20Regular, Globe20Regular, Lightbulb20Regular, Person20Regular, PlugConnected20Regular, PuzzlePiece20Regular,Settings20Regular, WindowConsole20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useState } from 'react';

import { Subtitle2 } from '@/renderer/ds';
import { SettingsModalAccountTab } from '@/renderer/features/SettingsModal/SettingsModalAccountTab';
import { SettingsModalAppsTab } from '@/renderer/features/SettingsModal/SettingsModalAppsTab';
import { SettingsModalEnvironmentTab } from '@/renderer/features/SettingsModal/SettingsModalEnvironmentTab';
import { SettingsModalExtensionsTab } from '@/renderer/features/SettingsModal/SettingsModalExtensionsTab';
import { SettingsModalGeneralTab } from '@/renderer/features/SettingsModal/SettingsModalGeneralTab';
import { SettingsModalMcpTab } from '@/renderer/features/SettingsModal/SettingsModalMcpTab';
import { SettingsModalModelsTab } from '@/renderer/features/SettingsModal/SettingsModalModelsTab';
import { SettingsModalNetworkTab } from '@/renderer/features/SettingsModal/SettingsModalNetworkTab';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { SettingsModalSkillsTab } from '@/renderer/features/SettingsModal/SettingsModalSkillsTab';
import { persistedStoreApi } from '@/renderer/services/store';

const TABS = [
  { value: 'General', label: 'General', icon: <Settings20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Environment', label: 'Environment', icon: <WindowConsole20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Models', label: 'Models', icon: <Cube20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'MCP', label: 'MCP Servers', icon: <PlugConnected20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Apps', label: 'Apps', icon: <Apps20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Skills', label: 'Skills', icon: <Lightbulb20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Network', label: 'Network', icon: <Globe20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Extensions', label: 'Extensions', icon: <PuzzlePiece20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Account', label: 'Account', icon: <Person20Regular style={{ width: 18, height: 18 }} /> },
] as const;

type SettingsTab = (typeof TABS)[number]['value'];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    '@media (min-width: 640px)': {
      flexDirection: 'row',
      overflowY: 'visible',
    },
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  navGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    borderRightColor: 'rgba(255, 255, 255, 0.14)',
  },
  contentGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
  },
  mobileTabsGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
  },
  /* ── Left nav ── */
  nav: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'flex',
      flexDirection: 'column',
      width: '220px',
      flexShrink: 0,
      ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
      paddingTop: '24px',
      paddingBottom: '24px',
      overflowY: 'auto',
    },
  },
  navHeader: {
    paddingLeft: '24px',
    paddingRight: '24px',
    paddingBottom: '16px',
  },
  navList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '8px',
    paddingBottom: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightRegular,
    width: '100%',
    textAlign: 'left',
    transitionProperty: 'color, background-color',
    transitionDuration: '100ms',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorNeutralForeground1,
    },
  },
  navItemActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  /* ── Right content ── */
  content: {
    flex: '1 1 0',
    minWidth: 0,
    paddingTop: '24px',
    paddingBottom: '24px',
    paddingLeft: '32px',
    paddingRight: '32px',
    '@media (min-width: 640px)': {
      overflowY: 'auto',
    },
    '@media (max-width: 639px)': {
      paddingLeft: '16px',
      paddingRight: '16px',
    },
  },
  contentInner: {
    maxWidth: '640px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  /* ── Mobile: tabs at top instead of side nav ── */
  mobileTabs: {
    display: 'flex',
    gap: '4px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    overflowX: 'auto',
    flexShrink: 0,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },
  mobileTab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: '12px',
    paddingRight: '12px',
    paddingTop: '10px',
    paddingBottom: '10px',
    minHeight: '40px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  mobileTabActive: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    color: tokens.colorNeutralForeground1,
  },
  footer: {
    paddingTop: '16px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
  },
});

export const SettingsPage = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const isGlass = !!store.codeDeckBackground;
  const [activeTab, setActiveTab] = useState<SettingsTab>('General');

  const handleNav = useCallback(
    (tab: SettingsTab) => () => setActiveTab(tab),
    []
  );

  return (
    <div
      className={mergeClasses(styles.root, isGlass && styles.rootGlass)}
      style={
        isGlass
          ? ({
              '--colorNeutralBackground2': 'rgba(255, 255, 255, 0.06)',
              '--colorNeutralBackground3': 'rgba(255, 255, 255, 0.04)',
              '--colorNeutralBackground4': 'rgba(255, 255, 255, 0.04)',
              '--colorNeutralBackground5': 'rgba(255, 255, 255, 0.04)',
              '--colorNeutralBackground6': 'rgba(255, 255, 255, 0.04)',
            } as CSSProperties)
          : undefined
      }
    >
      {/* Desktop: left nav */}
      <nav className={mergeClasses(styles.nav, isGlass && styles.navGlass)}>
        <div className={styles.navHeader}>
          <Subtitle2>Settings</Subtitle2>
        </div>
        <div className={styles.navList}>
          {TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={handleNav(tab.value)}
              className={mergeClasses(
                styles.navItem,
                activeTab === tab.value && styles.navItemActive
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Mobile: horizontal tabs */}
      <div className={mergeClasses(styles.mobileTabs, isGlass && styles.mobileTabsGlass)}>
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={handleNav(tab.value)}
            className={mergeClasses(
              styles.mobileTab,
              activeTab === tab.value && styles.mobileTabActive
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={mergeClasses(styles.content, isGlass && styles.contentGlass)}>
        <div className={styles.contentInner}>
          {activeTab === 'General' && <SettingsModalGeneralTab />}
          {activeTab === 'Environment' && <SettingsModalEnvironmentTab />}
          {activeTab === 'Models' && <SettingsModalModelsTab />}
          {activeTab === 'MCP' && <SettingsModalMcpTab />}
          {activeTab === 'Apps' && <SettingsModalAppsTab />}
          {activeTab === 'Skills' && <SettingsModalSkillsTab />}
          {activeTab === 'Network' && <SettingsModalNetworkTab />}
          {activeTab === 'Extensions' && <SettingsModalExtensionsTab />}
          {activeTab === 'Account' && <SettingsModalAccountTab />}
          {activeTab === 'General' && (
            <div className={styles.footer}>
              <SettingsModalResetButton />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
SettingsPage.displayName = 'SettingsPage';
