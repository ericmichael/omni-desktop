import { useStore } from '@nanostores/react';
import {
  Beaker,
  Bot,
  Box,
  CalendarClock,
  ChartNoAxesColumnIncreasing,
  Columns3,
  Ellipsis,
  Inbox,
  ListTodo,
  Puzzle,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
/**
 * The unified app sidebar (desktop): one persistent nav replacing the rail
 * and the per-tab sidebars. Three zones — fixed surface rows (New chat,
 * Inbox, Tasks, Activity) whose badges make the sidebar the attention surface;
 * container sections (Projects, Channels, DMs); and a pinned management
 * cluster (Agents, Routines, Dashboards, Plugins, Settings).
 *
 * On mobile the same nav is an overlay DRAWER (the ChatGPT/Gmail model):
 * the app lands on the working surface, and each surface's header carries a
 * leading affordance that slides this over it. There is no bottom tab bar
 * and no Home screen.
 */ import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/renderer/ds/ui/sidebar';
import { RecentsSection } from '@/renderer/features/Code/SessionsSection';
import { codeApi } from '@/renderer/features/Code/state';
import { useRecentConversations } from '@/renderer/features/Code/use-recent-conversations';
import { $commandPaletteOpen } from '@/renderer/features/CommandPalette/CommandPalette';
import { $activeInboxCount } from '@/renderer/features/Inbox/state';
import { ChannelsSection, DmsSection } from '@/renderer/features/Residents/sidebar-sections';
import { $residentsView, goToRoster } from '@/renderer/features/Residents/state';
import { goToRoutine } from '@/renderer/features/ScheduledTasks/state';
import { TeamSwitcher } from '@/renderer/features/Teams/TeamSwitcher';
import { ProjectsSection } from '@/renderer/features/Tickets/ProjectsSection';
import { $needsYouCount, $tickets, $ticketsView, ticketApi, viewToNavValue } from '@/renderer/features/Tickets/state';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { LayoutMode } from '@/shared/types';

export const AppSidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const ticketsView = useStore($ticketsView);
  const tickets = useStore($tickets);
  const residentsView = useStore($residentsView);
  const inboxCount = useStore($activeInboxCount);
  const needsYouCount = useStore($needsYouCount);
  const { setOpenMobile } = useSidebar();
  const { recent: recentConversations, sessionTitles } = useRecentConversations(store.codeTabs ?? []);

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter
      .invoke('platform:is-enterprise')
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);

  const closeDrawer = useCallback(() => setOpenMobile(false), [setOpenMobile]);
  const setMode = useCallback(
    (mode: LayoutMode) => {
      persistedStoreApi.setKey('layoutMode', mode);
      closeDrawer();
    },
    [closeDrawer]
  );
  const handleNewChat = useCallback(() => {
    void codeApi.openFreshChat();
    codeApi.setLayoutMode('focus');
    setMode('chat');
  }, [setMode]);
  const handleSpaces = useCallback(() => {
    codeApi.setLayoutMode('tile');
    setMode('chat');
  }, [setMode]);
  const handleInbox = useCallback(() => {
    ticketApi.goToInbox();
    closeDrawer();
  }, [closeDrawer]);
  const handleAllWork = useCallback(() => {
    ticketApi.goToAllWork();
    closeDrawer();
  }, [closeDrawer]);
  const handleRoster = useCallback(() => {
    goToRoster();
    closeDrawer();
  }, [closeDrawer]);
  const handleRoutines = useCallback(() => {
    goToRoutine();
    closeDrawer();
  }, [closeDrawer]);
  const handleDashboards = useCallback(() => setMode('dashboards'), [setMode]);
  const handlePlugins = useCallback(() => setMode('plugins'), [setMode]);
  const handleSandboxes = useCallback(() => setMode('sandboxes'), [setMode]);
  const handleGallery = useCallback(() => setMode('gallery'), [setMode]);
  const handleSettings = useCallback(() => setMode('settings'), [setMode]);
  const handlePalette = useCallback(() => $commandPaletteOpen.set(true), []);

  // Selection derives from (layoutMode, per-feature view atoms) — the same
  // derivation the per-tab sidebars used, widened to the app.
  const mode = store.layoutMode;
  const workNav = mode === 'work' ? viewToNavValue(ticketsView, tickets) : undefined;
  const agentsMode = mode === 'agents';
  // The Agents row covers the whole roster surface: directory, agent detail,
  // create form, and the handbook (which lives inside the directory).
  const rosterSelected =
    agentsMode &&
    (residentsView.showRoster === true ||
      residentsView.selectedAgentId !== null ||
      residentsView.showNewAgent === true ||
      residentsView.showHandbook === true);
  const routinesSelected = agentsMode && residentsView.showRoutines === true;
  // The More row owns every management surface — it paints selected when
  // any of them is frontmost, so "where am I" survives the collapse.
  const moreSelected =
    rosterSelected ||
    routinesSelected ||
    mode === 'dashboards' ||
    mode === 'plugins' ||
    mode === 'sandboxes' ||
    mode === 'gallery';

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="p-0">
        <div className="flex shrink-0 items-center gap-2 pt-8 pr-1 pb-5 pl-5">
          <OmniLogo />
          <h2 className={cn('min-w-0 truncate font-display text-lg font-semibold tracking-tight')}>Omni</h2>
          <TeamSwitcher />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Open command palette"
            onClick={handlePalette}
          >
            <Search />
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {/* ── Fixed surface rows — the badges are the attention system ── */}
        <SidebarGroup className="py-0">
          <SidebarGroupContent>
            <SidebarMenu aria-label="Surfaces">
              {/* Action row, never selected: landing in a fresh chat is the
                   app's default gesture (also the boot landing). */}
              <SidebarMenuItem>
                <SidebarMenuButton onClick={handleNewChat} tooltip="New chat">
                  <SquarePen />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={mode === 'chat' && store.codeLayoutMode === 'tile'}
                  onClick={handleSpaces}
                  tooltip="Spaces"
                >
                  <Columns3 />
                  <span>Spaces</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={workNav === 'inbox'} onClick={handleInbox} tooltip="Inbox">
                  <Inbox />
                  <span>Inbox</span>
                </SidebarMenuButton>
                {workNav !== 'inbox' && inboxCount > 0 && <SidebarMenuBadge>{inboxCount}</SidebarMenuBadge>}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={workNav === 'all-work'} onClick={handleAllWork} tooltip="Tasks">
                  <ListTodo />
                  <span>Tasks</span>
                </SidebarMenuButton>
                {workNav !== 'all-work' && needsYouCount > 0 && <SidebarMenuBadge>{needsYouCount}</SidebarMenuBadge>}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* ── Container sections ── */}
        <ProjectsSection sessionTitles={sessionTitles} onNavigate={closeDrawer} />
        <RecentsSection recent={recentConversations} sessionTitles={sessionTitles} onNavigate={closeDrawer} />
        <ChannelsSection onNavigate={closeDrawer} />
        <DmsSection onNavigate={closeDrawer} />
      </SidebarContent>

      {/* ── Management footer — the occasional surfaces live behind "More"
              (the Slack-rail idiom); Settings keeps direct access by universal
              convention. ── */}
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu aria-label="Management">
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton isActive={moreSelected} tooltip="More">
                  <Ellipsis />
                  <span>More</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={handleRoster}>
                    <Bot />
                    Agents
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleRoutines}>
                    <CalendarClock />
                    Routines
                  </DropdownMenuItem>
                  {isEnterprise && (
                    <DropdownMenuItem onClick={handleDashboards}>
                      <ChartNoAxesColumnIncreasing />
                      Dashboards
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={handlePlugins}>
                    <Puzzle />
                    Plugins
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleSandboxes}>
                    <Box />
                    Sandboxes
                  </DropdownMenuItem>
                  {import.meta.env.DEV && (
                    <DropdownMenuItem onClick={handleGallery}>
                      <Beaker />
                      Gallery
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={mode === 'settings'} onClick={handleSettings} tooltip="Settings">
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
});
AppSidebar.displayName = 'AppSidebar';
