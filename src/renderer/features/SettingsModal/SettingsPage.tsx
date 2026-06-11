import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  Apps20Regular,
  ArrowLeft20Regular,
  Branch20Regular,
  Cube20Regular,
  Globe20Regular,
  Keyboard20Regular,
  Lightbulb20Regular,
  MicSettings20Regular,
  Person20Regular,
  PlugConnected20Regular,
  PuzzlePiece20Regular,
  Settings20Regular,
  WindowConsole20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { IconButton, ListItem, Subtitle2 } from '@/renderer/ds';
import { SettingsModalAccountTab } from '@/renderer/features/SettingsModal/SettingsModalAccountTab';
import { SettingsModalAppsTab } from '@/renderer/features/SettingsModal/SettingsModalAppsTab';
import { SettingsModalAudioTab } from '@/renderer/features/SettingsModal/SettingsModalAudioTab';
import { SettingsModalEnvironmentTab } from '@/renderer/features/SettingsModal/SettingsModalEnvironmentTab';
import { SettingsModalExtensionsTab } from '@/renderer/features/SettingsModal/SettingsModalExtensionsTab';
import { SettingsModalGeneralTab } from '@/renderer/features/SettingsModal/SettingsModalGeneralTab';
import { SettingsModalGitTab } from '@/renderer/features/SettingsModal/SettingsModalGitTab';
import { SettingsModalHotkeysTab } from '@/renderer/features/SettingsModal/SettingsModalHotkeysTab';
import { SettingsModalMcpTab } from '@/renderer/features/SettingsModal/SettingsModalMcpTab';
import { SettingsModalModelsTab } from '@/renderer/features/SettingsModal/SettingsModalModelsTab';
import { SettingsModalNetworkTab } from '@/renderer/features/SettingsModal/SettingsModalNetworkTab';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { SettingsModalSkillsTab } from '@/renderer/features/SettingsModal/SettingsModalSkillsTab';
import { SettingsModalTeamsTab } from '@/renderer/features/SettingsModal/SettingsModalTeamsTab';
import { $glassEnabled } from '@/renderer/theme/use-glass';

const TABS = [
  { value: 'General', label: 'General', icon: <Settings20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Environment', label: 'Environment', icon: <WindowConsole20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Models', label: 'Models', icon: <Cube20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'MCP', label: 'MCP Servers', icon: <PlugConnected20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Git', label: 'Git', icon: <Branch20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Apps', label: 'Apps', icon: <Apps20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Skills', label: 'Skills', icon: <Lightbulb20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Audio', label: 'Audio', icon: <MicSettings20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Hotkeys', label: 'Hotkeys', icon: <Keyboard20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Network', label: 'Network', icon: <Globe20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Extensions', label: 'Extensions', icon: <PuzzlePiece20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Account', label: 'Account', icon: <Person20Regular style={{ width: 18, height: 18 }} /> },
  { value: 'Teams', label: 'Teams', icon: <Person20Regular style={{ width: 18, height: 18 }} /> },
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
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  contentGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  mobileHeaderGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
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
  /* ── Mobile: grouped list + drill-in panel instead of side nav ── */
  mobileList: {
    display: 'flex',
    flexDirection: 'column',
    paddingBottom: tokens.spacingVerticalL,
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },
  mobileListHeader: {
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingTop: '24px',
    paddingBottom: '12px',
  },
  mobilePanelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: '8px',
    paddingRight: '16px',
    paddingTop: '8px',
    paddingBottom: '8px',
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
  /* The selected panel only renders on mobile after a drill-in. */
  contentHiddenMobile: {
    '@media (max-width: 639px)': {
      display: 'none',
    },
  },
  footer: {
    paddingTop: '16px',
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
  },
});

export const SettingsPage = memo(() => {
  const styles = useStyles();
  const isGlass = useStore($glassEnabled);
  // null = no drill-in yet. Desktop always shows a panel (defaults to
  // General); mobile shows the grouped list until a row is tapped.
  const [activeTab, setActiveSettingsTab] = useState<SettingsTab | null>(null);
  const shownTab: SettingsTab = activeTab ?? 'General';

  const handleNav = useCallback((tab: SettingsTab) => () => setActiveSettingsTab(tab), []);
  const handleBack = useCallback(() => setActiveSettingsTab(null), []);

  const shownTabLabel = TABS.find((t) => t.value === shownTab)?.label ?? shownTab;

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
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
              className={mergeClasses(styles.navItem, shownTab === tab.value && styles.navItemActive)}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Mobile: grouped list (drill-in root) */}
      {activeTab === null && (
        <div className={styles.mobileList}>
          <div className={styles.mobileListHeader}>
            <Subtitle2>Settings</Subtitle2>
          </div>
          {TABS.map((tab) => (
            <ListItem key={tab.value} icon={tab.icon} label={tab.label} onClick={handleNav(tab.value)} />
          ))}
        </div>
      )}

      {/* Mobile: drill-in panel header */}
      {activeTab !== null && (
        <div className={mergeClasses(styles.mobilePanelHeader, isGlass && styles.mobileHeaderGlass)}>
          <IconButton aria-label="Back to settings" icon={<ArrowLeft20Regular />} size="sm" onClick={handleBack} />
          <Subtitle2>{shownTabLabel}</Subtitle2>
        </div>
      )}

      {/* Content */}
      <div
        className={mergeClasses(
          styles.content,
          isGlass && styles.contentGlass,
          activeTab === null && styles.contentHiddenMobile
        )}
      >
        <div className={styles.contentInner}>
          {shownTab === 'General' && <SettingsModalGeneralTab />}
          {shownTab === 'Environment' && <SettingsModalEnvironmentTab />}
          {shownTab === 'Models' && <SettingsModalModelsTab />}
          {shownTab === 'MCP' && <SettingsModalMcpTab />}
          {shownTab === 'Git' && <SettingsModalGitTab />}
          {shownTab === 'Apps' && <SettingsModalAppsTab />}
          {shownTab === 'Skills' && <SettingsModalSkillsTab />}
          {shownTab === 'Audio' && <SettingsModalAudioTab />}
          {shownTab === 'Hotkeys' && <SettingsModalHotkeysTab />}
          {shownTab === 'Network' && <SettingsModalNetworkTab />}
          {shownTab === 'Extensions' && <SettingsModalExtensionsTab />}
          {shownTab === 'Account' && <SettingsModalAccountTab />}
          {shownTab === 'Teams' && <SettingsModalTeamsTab />}
          {shownTab === 'General' && (
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
