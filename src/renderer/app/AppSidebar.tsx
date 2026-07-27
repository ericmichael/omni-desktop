import { Drawer, DrawerBody, makeStyles, mergeClasses, Subtitle2, tokens } from '@fluentui/react-components';
import {
  Beaker20Regular,
  Bot20Regular,
  CalendarClock20Regular,
  ColumnTriple20Regular,
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

import { $mobileNavOpen, closeMobileNav } from '@/renderer/app/mobile-nav';
import { OmniLogo } from '@/renderer/common/AsciiLogo';
import { useNavTreeStyles } from '@/renderer/common/nav-tree';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import {
  Button,
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
 * cluster (Agents, Routines, Dashboards, Plugins, Settings).
 *
 * On mobile the same nav is an overlay DRAWER (the ChatGPT/Gmail model):
 * the app lands on the working surface, and each surface's header carries a
 * leading affordance that slides this over it. There is no bottom tab bar
 * and no Home screen.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    '@media (min-width: 640px)': {
      width: '260px',
      flex: '0 0 auto',
      borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    },
  },
  /* Mobile drawer — visual chrome only. Do NOT set `position` here: Fluent
     anchors the surface with `position: fixed` + `top/bottom: 0` + `height:
     auto`, and forcing `absolute` on the portaled surface leaves those
     offsets without a resolvable containing block, so the height computes to
     0 and the drawer renders as an invisible 320×0 strip (measured). Size
     travels through `--fui-Drawer--size` (the `size` prop; small = 320px),
     which is also what the slide-in transform is measured from — so a raw
     `width`/`height` here would desync the animation even if it did render.
     Safe areas need no handling either: `mountNode` puts this inside the app
     shell, whose padding already holds them. */
  drawer: {
    backgroundColor: tokens.colorNeutralBackground2,
  },
  drawerBody: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minHeight: 0,
    width: '100%',
    padding: 0,
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
  /* Hugs its text now: the header's slack belongs to the Spaces button, and
     the wordmark ellipsizes first when a long team name crowds the row. */
  headerTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /* Pushed to the right edge so it reads as part of the header's action
     cluster with the command-palette button, not as a title. */
  spacesButton: {
    marginLeft: 'auto',
    flexShrink: 0,
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

export const AppSidebar = memo(({ mountNode }: { mountNode?: HTMLElement | null }) => {
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

  const mobileNavOpen = useStore($mobileNavOpen);

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter
      .invoke('platform:is-enterprise')
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);

  // Same-mode navigations (a project while already in Work, a channel while
  // in Agents) don't change layoutMode, so the drawer closes explicitly;
  // mode changes close it via the mobile-nav subscription. Either way this
  // is a navigation, so it sets the atom — `closeMobileNav` (which pops the
  // drawer's history entry) is for dismissals, and the drawer's own entry is
  // superseded by the destination instead.
  const closeDrawer = useCallback(() => $mobileNavOpen.set(false), []);
  // Scrim tap / Escape / swipe — a dismissal, so it pops.
  const handleOpenChange = useCallback((_e: unknown, data: { open: boolean }) => {
    if (!data.open) {
      closeMobileNav();
    }
  }, []);
  const setMode = useCallback((mode: LayoutMode) => {
    persistedStoreApi.setKey('layoutMode', mode);
    $mobileNavOpen.set(false);
  }, []);
  const handleNewChat = useCallback(() => {
    void codeApi.openFreshChat();
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
  // Spaces = the deck as a VIEW over every open session at once (layout
  // 'tile'), not a destination — so it's an action in the header, never a
  // nav row. Promoted here from the Sessions section header, where a bare
  // icon button among the row actions gave the app's headline multitasking
  // surface no label and no prominence.
  const handleOpenSpaces = useCallback(() => {
    codeApi.setLayoutMode('tile');
    setMode('chat');
  }, [setMode]);
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

  const body = (
    <>
      <div className={styles.header}>
        <OmniLogo />
        <Subtitle2 className={styles.headerTitle}>Omni</Subtitle2>
        <TeamSwitcher />
        <Button
          size="sm"
          className={styles.spacesButton}
          leftIcon={<ColumnTriple20Regular />}
          onClick={handleOpenSpaces}
        >
          Open Spaces
        </Button>
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
        <SessionsSection onNavigate={closeDrawer} />
        <ProjectsSection onNavigate={closeDrawer} />
        <ChannelsSection onNavigate={closeDrawer} />
        <DmsSection onNavigate={closeDrawer} />
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
    </>
  );

  if (isDesktop) {
    return <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>{body}</div>;
  }

  return (
    <Drawer
      open={mobileNavOpen}
      onOpenChange={handleOpenChange}
      position="start"
      type="overlay"
      {...(mountNode ? { mountNode } : {})}
      className={mergeClasses(styles.drawer, isGlass && styles.rootGlass)}
    >
      <DrawerBody className={styles.drawerBody}>{body}</DrawerBody>
    </Drawer>
  );
});
AppSidebar.displayName = 'AppSidebar';
