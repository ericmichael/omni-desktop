import { makeStyles, mergeClasses, Subtitle2, tokens } from '@fluentui/react-components';
import {
  Beaker20Regular,
  Bot20Regular,
  CalendarClock20Regular,
  Compose20Regular,
  Cube20Regular,
  DataBarVertical24Regular,
  MailInbox20Regular,
  MoreHorizontal20Regular,
  PuzzlePiece20Regular,
  Search20Regular,
  Settings20Regular,
  TaskListSquareLtr20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { $mobileHomeOpen } from '@/renderer/app/mobile-home';
import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import {
  CounterBadge,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Tree,
  TreeItem,
  TreeItemLayout,
} from '@/renderer/ds';
import { SessionsSection } from '@/renderer/features/Code/SessionsSection';
import { codeApi } from '@/renderer/features/Code/state';
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
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { LayoutMode } from '@/shared/types';

/**
 * The unified app sidebar (desktop): one persistent nav replacing the rail
 * and the per-tab sidebars. Three zones — fixed surface rows (New chat,
 * Inbox, Tasks, Activity) whose badges make the sidebar the attention surface;
 * container sections (Projects, Channels, DMs); and a pinned management
 * cluster (Agents, Routines, Dashboards, Plugins, Settings). Mobile keeps
 * the bottom tab bar until the sidebar becomes the mobile landing (phase 3).
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    // Mobile: the Home page — the same nav rendered full-screen above the
    // bottom bar (flex child of MainContent's column-reverse root).
    width: '100%',
    flex: '1 1 0',
    minHeight: 0,
    '@media (min-width: 640px)': {
      width: '260px',
      flex: '0 0 auto',
      height: '100%',
      borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  rootGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  /* Same geometry as PageHeader, but hosting the brand mark (PageHeader
     only takes a string title). */
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
    flexShrink: 0,
  },
  headerTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  scroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  bottom: {
    flexShrink: 0,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    paddingBottom: tokens.spacingVerticalS,
  },
});

export const AppSidebar = memo(() => {
  const styles = useStyles();
  const nav = useNavTreeStyles();
  const isDesktop = useIsDesktop();
  const isGlass = useStore($glassEnabled);
  const store = useStore(persistedStoreApi.$atom);
  const ticketsView = useStore($ticketsView);
  const tickets = useStore($tickets);
  const residentsView = useStore($residentsView);
  const inboxCount = useStore($activeInboxCount);
  const needsYouCount = useStore($needsYouCount);

  const mobileHomeOpen = useStore($mobileHomeOpen);

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter
      .invoke('platform:is-enterprise')
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);

  // Same-mode navigations (a project while already in Work, a channel while
  // in Agents) don't change layoutMode, so the Home page closes explicitly;
  // mode changes close it via the mobile-home subscription.
  const closeHome = useCallback(() => $mobileHomeOpen.set(false), []);
  const setMode = useCallback((mode: LayoutMode) => {
    persistedStoreApi.setKey('layoutMode', mode);
    $mobileHomeOpen.set(false);
  }, []);
  const handleNewChat = useCallback(() => {
    void codeApi.openFreshChat();
    setMode('chat');
  }, [setMode]);
  const handleInbox = useCallback(() => {
    ticketApi.goToInbox();
    closeHome();
  }, [closeHome]);
  const handleAllWork = useCallback(() => {
    ticketApi.goToAllWork();
    closeHome();
  }, [closeHome]);
  const handleRoster = useCallback(() => {
    goToRoster();
    closeHome();
  }, [closeHome]);
  const handleRoutines = useCallback(() => {
    goToRoutine();
    closeHome();
  }, [closeHome]);
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

  // Desktop: always visible. Mobile: only as the Home page.
  if (!isDesktop && !mobileHomeOpen) {
    return null;
  }

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={styles.header}>
        <OmniLogo />
        <Subtitle2 className={styles.headerTitle}>Omni</Subtitle2>
        <TeamSwitcher />
        <IconButton aria-label="Open command palette" icon={<Search20Regular />} size="sm" onClick={handlePalette} />
      </div>
      <div className={styles.scroll}>
        {/* ── Fixed surface rows — the badges are the attention system ── */}
        <Tree aria-label="Surfaces" className={nav.tree}>
          {/* Action row, never selected: landing in a fresh chat is the
              app's default gesture (also the boot landing). */}
          <TreeItem itemType="leaf" value="new-chat" className={nav.navItem} onClick={handleNewChat}>
            <TreeItemLayout iconBefore={<Compose20Regular />}>New chat</TreeItemLayout>
          </TreeItem>
          <TreeItem
            itemType="leaf"
            value="inbox"
            className={mergeClasses(nav.navItem, workNav === 'inbox' && nav.navItemSelected)}
            onClick={handleInbox}
          >
            <TreeItemLayout
              iconBefore={<MailInbox20Regular />}
              aside={
                workNav !== 'inbox' && inboxCount > 0 ? (
                  <CounterBadge count={inboxCount} size="small" color="brand" />
                ) : undefined
              }
            >
              Inbox
            </TreeItemLayout>
          </TreeItem>
          <TreeItem
            itemType="leaf"
            value="all-work"
            className={mergeClasses(nav.navItem, workNav === 'all-work' && nav.navItemSelected)}
            onClick={handleAllWork}
          >
            <TreeItemLayout
              iconBefore={<TaskListSquareLtr20Regular />}
              aside={
                workNav !== 'all-work' && needsYouCount > 0 ? (
                  <CounterBadge count={needsYouCount} size="small" color="brand" />
                ) : undefined
              }
            >
              Tasks
            </TreeItemLayout>
          </TreeItem>
        </Tree>

        {/* ── Container sections ── */}
        <SessionsSection onNavigate={closeHome} />
        <ProjectsSection onNavigate={closeHome} />
        <ChannelsSection onNavigate={closeHome} />
        <DmsSection onNavigate={closeHome} />
      </div>

      {/* ── Management footer — the occasional surfaces live behind "More"
          (the Slack-rail idiom); Settings keeps direct access by universal
          convention. ── */}
      <div className={styles.bottom}>
        <Tree aria-label="Management" className={nav.tree}>
          <Menu positioning={{ position: 'above', align: 'start' }}>
            <MenuTrigger disableButtonEnhancement>
              <TreeItem
                itemType="leaf"
                value="more"
                className={mergeClasses(nav.navItem, moreSelected && nav.navItemSelected)}
              >
                <TreeItemLayout iconBefore={<MoreHorizontal20Regular />}>More</TreeItemLayout>
              </TreeItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Bot20Regular />} onClick={handleRoster}>
                  Agents
                </MenuItem>
                <MenuItem icon={<CalendarClock20Regular />} onClick={handleRoutines}>
                  Routines
                </MenuItem>
                {isEnterprise && (
                  <MenuItem icon={<DataBarVertical24Regular />} onClick={handleDashboards}>
                    Dashboards
                  </MenuItem>
                )}
                <MenuItem icon={<PuzzlePiece20Regular />} onClick={handlePlugins}>
                  Plugins
                </MenuItem>
                <MenuItem icon={<Cube20Regular />} onClick={handleSandboxes}>
                  Sandboxes
                </MenuItem>
                {import.meta.env.DEV && (
                  <MenuItem icon={<Beaker20Regular />} onClick={handleGallery}>
                    Gallery
                  </MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
          <TreeItem
            itemType="leaf"
            value="settings"
            className={mergeClasses(nav.navItem, mode === 'settings' && nav.navItemSelected)}
            onClick={handleSettings}
          >
            <TreeItemLayout iconBefore={<Settings20Regular />}>Settings</TreeItemLayout>
          </TreeItem>
        </Tree>
      </div>
    </div>
  );
});
AppSidebar.displayName = 'AppSidebar';
