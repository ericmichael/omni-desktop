import { useStore } from '@nanostores/react';
import {
  ArrowLeft,
  Box,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  Puzzle,
  Rocket,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  User,
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/renderer/ds/ui/sidebar';
import { openPlugins } from '@/renderer/features/Plugins/plugins-nav';
import { $settingsInitialTab } from '@/renderer/features/SettingsModal/settings-nav';
import { SettingsModalAccountTab } from '@/renderer/features/SettingsModal/SettingsModalAccountTab';
import { SettingsModalAiTab } from '@/renderer/features/SettingsModal/SettingsModalAiTab';
import { SettingsModalAppearanceTab } from '@/renderer/features/SettingsModal/SettingsModalAppearanceTab';
import { SettingsModalAudioTab } from '@/renderer/features/SettingsModal/SettingsModalAudioTab';
import { SettingsModalEnvironmentTab } from '@/renderer/features/SettingsModal/SettingsModalEnvironmentTab';
import { SettingsModalGeneralTab } from '@/renderer/features/SettingsModal/SettingsModalGeneralTab';
import { SettingsModalGitTab } from '@/renderer/features/SettingsModal/SettingsModalGitTab';
import { SettingsModalHotkeysTab } from '@/renderer/features/SettingsModal/SettingsModalHotkeysTab';
import { SettingsModalNetworkTab } from '@/renderer/features/SettingsModal/SettingsModalNetworkTab';
import { SettingsModalProjectsTab } from '@/renderer/features/SettingsModal/SettingsModalProjectsTab';
import { SettingsModalResetButton } from '@/renderer/features/SettingsModal/SettingsModalResetButton';
import { SettingsModalTeamsTab } from '@/renderer/features/SettingsModal/SettingsModalTeamsTab';
import { SettingsModalWorkspaceTab } from '@/renderer/features/SettingsModal/SettingsModalWorkspaceTab';

type SettingsTab =
  | 'General'
  | 'AI'
  | 'Appearance'
  | 'Projects'
  | 'Audio'
  | 'Hotkeys'
  | 'Account'
  | 'Teams'
  | 'Workspace'
  | 'Environment'
  | 'Git'
  | 'Network';

type TabDef = { value: SettingsTab; label: string; icon: React.JSX.Element };

/**
 * Two altitudes (macOS System Settings pattern): the Personal band is what
 * everyday users need; the Developer band holds infrastructure. Order within
 * a band is rough frequency-of-use.
 */
const TAB_GROUPS: ReadonlyArray<{ label: string | null; tabs: ReadonlyArray<TabDef> }> = [
  {
    label: null,
    tabs: [
      { value: 'General', label: 'General', icon: <Settings /> },
      { value: 'AI', label: 'AI', icon: <Box /> },
      { value: 'Appearance', label: 'Appearance', icon: <Palette /> },
      { value: 'Projects', label: 'Projects', icon: <Rocket /> },
      { value: 'Audio', label: 'Voice & Audio', icon: <SlidersHorizontal /> },
      { value: 'Hotkeys', label: 'Hotkeys', icon: <Keyboard /> },
      { value: 'Account', label: 'Account', icon: <User /> },
      { value: 'Teams', label: 'Teams', icon: <User /> },
    ],
  },
  {
    label: 'Developer',
    tabs: [
      { value: 'Workspace', label: 'Workspace & Sandbox', icon: <Box /> },
      { value: 'Environment', label: 'Environment', icon: <SquareTerminal /> },
      { value: 'Git', label: 'Git', icon: <GitBranch /> },
      { value: 'Network', label: 'Network', icon: <Globe /> },
    ],
  },
];

const TABS: ReadonlyArray<TabDef> = TAB_GROUPS.flatMap((g) => [...g.tabs]);

export const SettingsPage = memo(() => {
  // null = no drill-in yet. Desktop always shows a panel (defaults to
  // General); mobile shows the grouped list until a row is tapped.
  const [activeTab, setActiveSettingsTab] = useState<SettingsTab | null>(null);
  const shownTab: SettingsTab = activeTab ?? 'General';

  // Deep link (e.g. the session banner's "Check AI settings"): consume the
  // one-shot target and clear it. The page never unmounts, hence the atom.
  const initialTab = useStore($settingsInitialTab);
  useEffect(() => {
    if (initialTab && TABS.some((t) => t.value === initialTab)) {
      setActiveSettingsTab(initialTab as SettingsTab);
      $settingsInitialTab.set(null);
    }
  }, [initialTab]);

  const handleNav = useCallback((tab: SettingsTab) => () => setActiveSettingsTab(tab), []);
  const handleBack = useCallback(() => setActiveSettingsTab(null), []);

  const shownTabLabel = TABS.find((t) => t.value === shownTab)?.label ?? shownTab;

  return (
    <div className="flex flex-col w-full h-full min-h-0 overflow-y-auto bg-background sm:flex-row sm:overflow-y-visible">
      {/* Desktop: left nav */}
      <nav className="hidden sm:flex sm:flex-col sm:w-56 sm:shrink-0 sm:border-r border-border sm:pt-6 sm:pb-6 sm:overflow-y-auto">
        <div className="pl-6 pr-6 pb-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Settings</h2>
        </div>
        <SidebarContent>
          {TAB_GROUPS.map((group, groupIndex) => (
            <SidebarGroup key={group.label ?? 'personal'} className={cn(groupIndex > 0 && 'pt-0')}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.tabs.map((tab) => (
                    <SidebarMenuItem key={tab.value}>
                      <SidebarMenuButton type="button" isActive={shownTab === tab.value} onClick={handleNav(tab.value)}>
                        {tab.icon}
                        <span>{tab.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </nav>

      {/* Mobile: grouped list (drill-in root) */}
      {activeTab === null && (
        <div className="flex flex-col pb-5 sm:hidden">
          <div className="flex items-center gap-2 pl-2 pr-5 pt-6 pb-3">
            <SidebarTrigger size="icon-sm" aria-label="Open navigation" />
            <h2 className="font-display text-lg font-semibold tracking-tight">Settings</h2>
          </div>
          {TAB_GROUPS.map((group) => (
            <SidebarGroup key={group.label ?? 'personal'}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.tabs.map((tab) => (
                    <SidebarMenuItem key={tab.value}>
                      <SidebarMenuButton type="button" onClick={handleNav(tab.value)}>
                        {tab.icon}
                        <span>{tab.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
          {/* Plugins is configuration too — kept alongside the settings
            groups so it's reachable without walking back out to Home. */}
          <SidebarGroup className="pt-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton type="button" onClick={() => openPlugins()}>
                    <Puzzle />
                    <span>Plugins</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </div>
      )}

      {/* Mobile: drill-in panel header */}
      {activeTab !== null && (
        <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border bg-background py-2 pl-2 pr-4 sm:hidden">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Back to settings" onClick={handleBack}>
            <ArrowLeft />
          </Button>
          <h2 className="font-display text-lg font-semibold tracking-tight">{shownTabLabel}</h2>
        </div>
      )}

      {/* Content */}
      <div
        className={cn(
          'flex-1 min-w-0 pt-6 pb-6 pl-8 pr-8 sm:overflow-y-auto max-sm:pl-4 max-sm:pr-4',
          activeTab === null && 'max-sm:hidden'
        )}
      >
        <div className="max-w-2xl flex flex-col gap-6">
          {shownTab === 'General' && <SettingsModalGeneralTab />}
          {shownTab === 'AI' && <SettingsModalAiTab />}
          {shownTab === 'Appearance' && <SettingsModalAppearanceTab />}
          {shownTab === 'Projects' && <SettingsModalProjectsTab />}
          {shownTab === 'Audio' && <SettingsModalAudioTab />}
          {shownTab === 'Hotkeys' && <SettingsModalHotkeysTab />}
          {shownTab === 'Account' && <SettingsModalAccountTab />}
          {shownTab === 'Teams' && <SettingsModalTeamsTab />}
          {shownTab === 'Workspace' && <SettingsModalWorkspaceTab />}
          {shownTab === 'Environment' && <SettingsModalEnvironmentTab />}
          {shownTab === 'Git' && <SettingsModalGitTab />}
          {shownTab === 'Network' && <SettingsModalNetworkTab />}
          {shownTab === 'General' && (
            <div className="pt-4 border-t border-border">
              <SettingsModalResetButton />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
SettingsPage.displayName = 'SettingsPage';
