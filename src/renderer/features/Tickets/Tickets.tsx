import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, Navigation20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { IconButton, TopAppBar } from '@/renderer/ds';
import { InboxView } from '@/renderer/features/Inbox/InboxView';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { PageView } from '@/renderer/features/Pages/PageView';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';

import { MilestoneDetail } from './MilestoneDetail';
import { ProjectActions, ProjectPage } from './ProjectPage';
import { ProjectsDashboard } from './ProjectsDashboard';
import { TicketsSidebar } from './Sidebar';
import { $activeWipTickets, $ticketsView, $wipDialogPendingProfileName, $wipDialogPendingTicket, ticketApi } from './state';
import { TicketAutopilotLaunchDialog } from './TicketAutopilotLaunchDialog';
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
  // Glass surfaces inherit translucent neutral colors via Fluent token overrides
  // pushed at the deck-bg root in MainContent. These classes only opt in to the
  // blur layer — bg/border colors come from --colorNeutralBackground* / --colorNeutralStroke1.
  desktopSidebarGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  contentAreaGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  desktopSidebar: {
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'block',
      ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke1),
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

/* ---------- Main export ---------- */

export const Tickets = memo(() => {
  const styles = useStyles();
  const persistedStore = useStore(persistedStoreApi.$atom);
  const isGlass = useStore($glassEnabled);
  const view = useStore($ticketsView);
  const isDesktop = useIsDesktop();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const pages = useStore($pages);
  const milestones = useStore($milestones);
  const tickets = persistedStore.tickets;

  const activeTicket = useMemo(
    () => (view.type === 'ticket' ? (tickets.find((ticket) => ticket.id === view.ticketId) ?? null) : null),
    [view, tickets]
  );
  const activeProject = useMemo(() => {
    const projectId =
      view.type === 'project' || view.type === 'page' || view.type === 'milestone' || view.type === 'board'
        ? view.projectId
        : activeTicket?.projectId;
    return projectId ? (persistedStore.projects.find((project) => project.id === projectId) ?? null) : null;
  }, [view, activeTicket?.projectId, persistedStore.projects]);

  useEffect(() => {
    if (isDesktop) {
      setMobileNavOpen(false);
    }
  }, [isDesktop]);

  // The TopAppBar is the only header on mobile, so it titles the current view.
  const mobileHeaderTitle = useMemo(() => {
    if (view.type === 'dashboard') {
      return 'Home';
    }
    if (view.type === 'inbox') {
      return view.selectedItemId ? 'Inbox Item' : 'Inbox';
    }
    if (view.type === 'ticket') {
      return activeTicket?.title || 'Ticket';
    }
    if (view.type === 'page') {
      return pages[view.pageId]?.title || 'Untitled';
    }
    if (view.type === 'milestone') {
      return milestones[view.milestoneId]?.title || 'Milestone';
    }
    if (view.type === 'board') {
      return 'Board';
    }
    if (view.type === 'project') {
      return activeProject?.label || 'Project';
    }
    return 'Projects';
  }, [view, pages, milestones, activeTicket?.title, activeProject?.label]);

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

  const handleInboxBack = useCallback(() => {
    ticketApi.goToInbox();
  }, []);

  const handleInboxHomeBack = useCallback(() => {
    ticketApi.goToDashboard();
  }, []);

  const handleOpenMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const handleCloseMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const handleAddInboxItem = useCallback(() => {
    $quickCaptureOpen.set(true);
  }, []);
  const mobileBackHandler =
    view.type === 'dashboard'
      ? undefined
      : view.type === 'inbox'
        ? view.selectedItemId
          ? handleInboxBack
          : handleInboxHomeBack
        : view.type === 'ticket'
          ? handleTicketBack
          : handleBack;
  const mobileNavButton = (
    <IconButton aria-label="Open navigation" icon={<Navigation20Regular />} size="sm" onClick={handleOpenMobileNav} />
  );
  const mobileAddInboxButton = (
    <IconButton aria-label="Add inbox item" icon={<Add20Regular />} size="sm" onClick={handleAddInboxItem} />
  );

  // Keyboard shortcut: Cmd/Ctrl+N → new page in current project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        const projectId =
          view.type === 'project'
            ? view.projectId
            : view.type === 'page'
              ? view.projectId
              : view.type === 'milestone'
                ? view.projectId
                : view.type === 'board'
                  ? view.projectId
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
        void pageApi
          .addPage({
            projectId,
            parentId: rootPage.id,
            title: 'Untitled',
            sortOrder: maxSort + 1,
          })
          .then((newPage) => {
            ticketApi.goToPage(newPage.id, projectId);
          });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view]);

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      {/* Desktop: sidebar always visible */}
      <div className={mergeClasses(styles.desktopSidebar, isGlass && styles.desktopSidebarGlass)}>
        <TicketsSidebar />
      </div>

      <div className={styles.mainColumn}>
        {/* Mobile: header with sidebar access */}
        <div className={styles.mobileHeader}>
          <TopAppBar
            title={mobileHeaderTitle}
            onBack={mobileBackHandler}
            leading={mobileNavButton}
            actions={
              view.type === 'inbox' && !view.selectedItemId ? (
                mobileAddInboxButton
              ) : view.type === 'project' ? (
                <ProjectActions projectId={view.projectId} />
              ) : undefined
            }
            className={isGlass ? 'omni-glass-mobile-top-app-bar' : 'bg-surface-raised'}
          />
        </div>

        {/* Content — only mount one layout to avoid duplicate stateful editors */}
        <div className={mergeClasses(styles.contentArea, isGlass && styles.contentAreaGlass)}>
          {isDesktop ? (
            <div className={styles.desktopContent}>
              {view.type === 'inbox' && <InboxView selectedItemId={view.selectedItemId} />}
              {view.type === 'project' && <ProjectPage projectId={view.projectId} />}
              {view.type === 'page' && <PageView key={view.pageId} pageId={view.pageId} projectId={view.projectId} />}
              {view.type === 'milestone' && (
                <MilestoneDetail milestoneId={view.milestoneId} projectId={view.projectId} />
              )}
              {view.type === 'board' && (
                <WorkItemsList
                  projectId={view.projectId}
                  title="Board"
                  contextLabel={activeProject?.label}
                  onBack={handleBack}
                />
              )}
              {view.type === 'ticket' && (
                <TicketDetail
                  key={view.ticketId}
                  ticketId={view.ticketId}
                  onClose={handleTicketBack}
                  closeBehavior="back"
                />
              )}
              {view.type === 'dashboard' && <ProjectsDashboard />}
            </div>
          ) : (
            <div className={styles.mobileContent}>
              {view.type === 'inbox' && <InboxView selectedItemId={view.selectedItemId} hideChrome />}
              {view.type === 'ticket' && (
                <TicketDetail
                  key={view.ticketId}
                  ticketId={view.ticketId}
                  onClose={handleTicketBack}
                  closeBehavior="back"
                  hideTitleBar
                />
              )}
              {view.type === 'page' && <PageView key={view.pageId} pageId={view.pageId} projectId={view.projectId} />}
              {view.type === 'milestone' && (
                <MilestoneDetail milestoneId={view.milestoneId} projectId={view.projectId} hideChrome />
              )}
              {view.type === 'board' && <WorkItemsList projectId={view.projectId} hideChrome />}
              {view.type === 'project' && <ProjectPage projectId={view.projectId} />}
              {view.type === 'dashboard' && <ProjectsDashboard />}
            </div>
          )}
        </div>
      </div>

      {!isDesktop && (
        <TicketsSidebar
          type="overlay"
          open={mobileNavOpen}
          onClose={handleCloseMobileNav}
          onNavigate={handleCloseMobileNav}
        />
      )}

      <WipLimitOverlay />
      <TicketAutopilotLaunchDialog />
    </div>
  );
});
Tickets.displayName = 'Tickets';

/** Renders the WIP limit dialog when a pending ticket is set. */
const WipLimitOverlay = memo(() => {
  const pendingTicket = useStore($wipDialogPendingTicket);
  const activeTickets = useStore($activeWipTickets);

  const handleDrop = useCallback((_droppedTicketId: string) => {
    const pending = $wipDialogPendingTicket.get();
    const profileName = $wipDialogPendingProfileName.get();
    $wipDialogPendingTicket.set(null);
    $wipDialogPendingProfileName.set(undefined);
    // After stopping the dropped ticket, start the pending one
    if (pending) {
      // Small delay to let the stop propagate
      setTimeout(() => {
        void ticketApi.startSupervisor(pending.id, { profileName });
      }, 500);
    }
  }, []);

  const handleCancel = useCallback(() => {
    $wipDialogPendingTicket.set(null);
    $wipDialogPendingProfileName.set(undefined);
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
