import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { CounterBadge, Tab, TabList, TopAppBar } from '@/renderer/ds';
import { InboxView } from '@/renderer/features/Inbox/InboxView';
import { $activeInboxCount } from '@/renderer/features/Inbox/state';
import { PageView } from '@/renderer/features/Pages/PageView';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';

import { MilestoneDetail } from './MilestoneDetail';
import { ProjectPage } from './ProjectPage';
import { ProjectsDashboard } from './ProjectsDashboard';
import { TicketsSidebar } from './Sidebar';
import { $activeWipTickets, $ticketsView, $wipDialogPendingTicket, ticketApi } from './state';
import { TicketDetail } from './TicketDetail';
import { WipLimitDialog } from './WipLimitDialog';
import { WorkItemsList } from './WorkItemsList';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  mobileTabBarGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
  },
  desktopSidebarGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
    borderRight: '1px solid rgba(255, 255, 255, 0.14)',
  },
  contentAreaGlass: {
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 22%, transparent)`,
    backdropFilter: 'blur(36px) saturate(160%)',
    WebkitBackdropFilter: 'blur(36px) saturate(160%)',
  },
  desktopSidebar: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'block',
    },
  },
  mainColumn: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  mobileHeader: {
    flexShrink: 0,
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },
  mobileTabBar: {
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  inboxBadge: {
    marginLeft: tokens.spacingHorizontalXS,
  },
  contentArea: {
    flex: '1 1 0',
    minHeight: 0,
  },
  desktopContent: {
    display: 'block',
    height: '100%',
  },
  mobileContent: {
    height: '100%',
  },
});

/* ---------- Desktop breakpoint (matches SM_BREAKPOINT = 640px) ---------- */

const DESKTOP_MQ = '(min-width: 640px)';
const subscribeMQ = (cb: () => void) => {
  const mql = window.matchMedia(DESKTOP_MQ);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};
const getIsDesktop = () => window.matchMedia(DESKTOP_MQ).matches;
const getIsDesktopServer = () => true;

function useIsDesktop() {
  return useSyncExternalStore(subscribeMQ, getIsDesktop, getIsDesktopServer);
}

/* ---------- Mobile tab type ---------- */

type MobileTab = 'inbox' | 'projects';

/* ---------- Main export ---------- */

export const Tickets = memo(() => {
  const styles = useStyles();
  const persistedStore = useStore(persistedStoreApi.$atom);
  const isGlass = !!persistedStore.codeDeckBackground;
  const view = useStore($ticketsView);
  const isDesktop = useIsDesktop();
  const [mobileTab, setMobileTab] = useState<MobileTab>(view.type === 'inbox' ? 'inbox' : 'projects');

  const pages = useStore($pages);
  const tickets = persistedStore.tickets;

  const openInboxCount = useStore($activeInboxCount);
  const activeTicket = useMemo(
    () => (view.type === 'ticket' ? tickets.find((ticket) => ticket.id === view.ticketId) ?? null : null),
    [view, tickets]
  );
  const activeProject = useMemo(() => {
    const projectId =
      view.type === 'project' || view.type === 'page' || view.type === 'milestone' || view.type === 'board'
        ? view.projectId
        : activeTicket?.projectId;
    return projectId ? persistedStore.projects.find((project) => project.id === projectId) ?? null : null;
  }, [view, activeTicket?.projectId, persistedStore.projects]);

  const isViewingProject = view.type === 'project' || view.type === 'page' || view.type === 'milestone' || view.type === 'board';

  // Context-aware back navigation for mobile
  const mobileBackTitle = useMemo(() => {
    if (view.type === 'page') {
      const page = pages[view.pageId];
      if (page?.parentId) {
        const parent = pages[page.parentId];
        return parent?.title ?? 'Back';
      }
      return 'Project';
    }
    if (view.type === 'milestone') {
      return 'Project';
    }
    if (view.type === 'board') {
      return 'Project';
    }
    return 'Projects';
  }, [view, pages]);

  const handleBack = useCallback(() => {
    if (view.type === 'page') {
      const page = pages[view.pageId];
      if (page?.parentId) {
        // Navigate to parent page
        const parent = pages[page.parentId];
        if (parent?.isRoot) {
          ticketApi.goToProject(view.projectId);
        } else {
          ticketApi.goToPage(page.parentId, view.projectId);
        }
        return;
      }
      ticketApi.goToProject(view.projectId);
      return;
    }
    if (view.type === 'milestone') {
      ticketApi.goToProject(view.projectId);
      return;
    }
    if (view.type === 'board') {
      ticketApi.goToProject(view.projectId);
      return;
    }
    ticketApi.goToDashboard();
  }, [view, pages]);

  const handleTicketBack = useCallback(() => {
    ticketApi.goBackToPrevious(activeTicket?.projectId);
  }, [activeTicket?.projectId]);

  // Keyboard shortcut: Cmd/Ctrl+N → new page in current project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        const projectId =
          view.type === 'project' ? view.projectId
          : view.type === 'page' ? view.projectId
          : view.type === 'milestone' ? view.projectId
          : view.type === 'board' ? view.projectId
          : null;
        if (!projectId) {
          return;
        }
        e.preventDefault();
        const allPages = $pages.get();
        const rootPage = Object.values(allPages).find((p) => p.projectId === projectId && p.isRoot);
        if (!rootPage) {
          return;
        }
        const siblings = Object.values(allPages).filter((p) => p.parentId === rootPage.id);
        const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
        void pageApi.addPage({
          projectId,
          parentId: rootPage.id,
          title: 'Untitled',
          sortOrder: maxSort + 1,
        }).then((newPage) => {
          ticketApi.goToPage(newPage.id, projectId);
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view]);

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
      {/* Desktop: sidebar always visible */}
      <div className={mergeClasses(styles.desktopSidebar, isGlass && styles.desktopSidebarGlass)}>
        <TicketsSidebar />
      </div>

      <div className={styles.mainColumn}>
        {/* Mobile: tab bar or back header */}
        <div className={styles.mobileHeader}>
          {mobileTab === 'projects' && isViewingProject ? (
            /* Back header when viewing a project/page/milestone detail */
            <TopAppBar title={mobileBackTitle} onBack={handleBack} className="bg-surface-raised" />
          ) : (
            /* Tab bar: Inbox / Projects */
            <div className={mergeClasses(styles.mobileTabBar, isGlass && styles.mobileTabBarGlass)}>
              <TabList
                selectedValue={mobileTab}
                onTabSelect={(_e, data) => {
                  const tab = data.value as MobileTab;
                  setMobileTab(tab);
                  if (tab === 'inbox') {
                    ticketApi.goToInbox();
                  } else {
                    ticketApi.goToDashboard();
                  }
                }}
                appearance="subtle"
                style={{ width: '100%' }}
              >
                <Tab value="inbox" style={{ flex: '1 1 0', justifyContent: 'center' }}>
                  Inbox
                  {openInboxCount > 0 && (
                    <CounterBadge count={openInboxCount} size="small" color="brand" className={styles.inboxBadge} />
                  )}
                </Tab>
                <Tab value="projects" style={{ flex: '1 1 0', justifyContent: 'center' }}>
                  Projects
                </Tab>
              </TabList>
            </div>
          )}
        </div>

        {/* Content — only mount one layout to avoid duplicate stateful editors */}
        <div className={mergeClasses(styles.contentArea, isGlass && styles.contentAreaGlass)}>
          {isDesktop ? (
            <div className={styles.desktopContent}>
              {view.type === 'inbox' && <InboxView selectedItemId={view.selectedItemId} />}
              {view.type === 'project' && <ProjectPage projectId={view.projectId} />}
              {view.type === 'page' && <PageView key={view.pageId} pageId={view.pageId} projectId={view.projectId} />}
              {view.type === 'milestone' && <MilestoneDetail milestoneId={view.milestoneId} projectId={view.projectId} />}
              {view.type === 'board' && (
                <WorkItemsList projectId={view.projectId} title="Board" contextLabel={activeProject?.label} onBack={handleBack} />
              )}
              {view.type === 'ticket' && <TicketDetail ticketId={view.ticketId} onClose={handleTicketBack} closeBehavior="back" />}
              {view.type === 'dashboard' && <ProjectsDashboard />}
            </div>
          ) : (
            <div className={styles.mobileContent}>
              {mobileTab === 'inbox' && <InboxView selectedItemId={view.type === 'inbox' ? view.selectedItemId : undefined} />}
              {mobileTab === 'projects' && (
                view.type === 'ticket'
                  ? <TicketDetail ticketId={view.ticketId} onClose={handleTicketBack} closeBehavior="back" />
                  : view.type === 'page'
                    ? <PageView key={view.pageId} pageId={view.pageId} projectId={view.projectId} />
                    : view.type === 'milestone'
                      ? <MilestoneDetail milestoneId={view.milestoneId} projectId={view.projectId} />
                      : view.type === 'board'
                        ? <WorkItemsList projectId={view.projectId} />
                        : view.type === 'project'
                        ? <ProjectPage projectId={view.projectId} />
                        : <ProjectsDashboard />
              )}
            </div>
          )}
        </div>
      </div>

      <WipLimitOverlay />
    </div>
  );
});
Tickets.displayName = 'Tickets';

/** Renders the WIP limit dialog when a pending ticket is set. */
const WipLimitOverlay = memo(() => {
  const pendingTicket = useStore($wipDialogPendingTicket);
  const activeTickets = useStore($activeWipTickets);

  const handleDrop = useCallback((droppedTicketId: string) => {
    const pending = $wipDialogPendingTicket.get();
    $wipDialogPendingTicket.set(null);
    // After stopping the dropped ticket, start the pending one
    if (pending) {
      // Small delay to let the stop propagate
      setTimeout(() => {
        void ticketApi.startSupervisor(pending.id);
      }, 500);
    }
  }, []);

  const handleCancel = useCallback(() => {
    $wipDialogPendingTicket.set(null);
  }, []);

  if (!pendingTicket) {
    return null;
  }

  return (
    <WipLimitDialog
      pendingTicket={pendingTicket}
      activeTickets={activeTickets}
      onDrop={handleDrop}
      onCancel={handleCancel}
    />
  );
});
WipLimitOverlay.displayName = 'WipLimitOverlay';
