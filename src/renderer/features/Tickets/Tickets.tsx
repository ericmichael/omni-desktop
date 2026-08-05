import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { TopAppBar } from '@/renderer/ds/TopAppBar';
import { InboxView } from '@/renderer/features/Inbox/InboxView';
import { $inboxItems, $inboxView } from '@/renderer/features/Inbox/state';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { PageView } from '@/renderer/features/Pages/PageView';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { MilestoneDetail } from './MilestoneDetail';
import { ProjectHome } from './ProjectHome';
import { ProjectPagesTab } from './ProjectPagesTab';
import { ProjectSettings } from './ProjectSettings';
import { ProjectShell } from './ProjectShell';
import { $ticketsView, type ProjectTab, ticketApi } from './state';
import { TicketDetail } from './TicketDetail';
import { WorkAllView } from './WorkAllView';
import { WorkItemsList } from './WorkItemsList';

/* ---------- Main export ---------- */

/**
 * The Work surface: the inbox, all projects, and their tasks. The unified
 * AppSidebar picks the view (desktop column; the mobile nav drawer). Every
 * project-scoped routes stay inside a persistent local shell; on mobile the
 * TopAppBar carries the drawer handle at a surface root and a back arrow at
 * depth.
 */
export const Tickets = memo(() => {
  const persistedStore = useStore(persistedStoreApi.$atom);
  const view = useStore($ticketsView);
  const isDesktop = useIsDesktop();

  const pages = useStore($pages);
  const milestones = useStore($milestones);
  const inboxView = useStore($inboxView);
  const inboxItems = useStore($inboxItems);
  const tickets = persistedStore.tickets;

  const activeTicket = useMemo(
    () => (view.type === 'ticket' ? (tickets.find((ticket) => ticket.id === view.ticketId) ?? null) : null),
    [view, tickets]
  );
  // The project every project-scoped view hangs off (ticket views resolve
  // through the ticket record).
  const shellProjectId: ProjectId | null = useMemo(() => {
    if (view.type === 'project' || view.type === 'page' || view.type === 'milestone') {
      return view.projectId;
    }
    if (view.type === 'ticket') {
      return activeTicket?.projectId ?? null;
    }
    return null;
  }, [view, activeTicket?.projectId]);
  const activeProject = useMemo(
    () => (shellProjectId ? (persistedStore.projects.find((project) => project.id === shellProjectId) ?? null) : null),
    [shellProjectId, persistedStore.projects]
  );

  // The TopAppBar is the only header on mobile, so it titles the current view.
  const mobileHeaderTitle = useMemo(() => {
    if (view.type === 'all') {
      return 'Tasks';
    }
    if (view.type === 'inbox') {
      // The open item titles the bar (its own back header is suppressed).
      const item = inboxView.selectedItemId ? inboxItems[inboxView.selectedItemId] : null;
      return item?.title || 'Inbox';
    }
    if (view.type === 'ticket') {
      return activeTicket?.title || 'Task';
    }
    if (view.type === 'page') {
      return pages[view.pageId]?.title || 'Untitled';
    }
    if (view.type === 'milestone') {
      return milestones[view.milestoneId]?.title || 'Milestone';
    }
    if (view.type === 'project') {
      if (view.tab === 'tasks') {
        return 'Tasks';
      }
      if (view.tab === 'pages') {
        return 'Pages';
      }
      if (view.tab === 'settings') {
        return 'Settings';
      }
      return activeProject?.label || 'Project';
    }
    return 'Work';
  }, [view, pages, milestones, inboxView.selectedItemId, inboxItems, activeTicket?.title, activeProject?.label]);

  const handleBack = useCallback(() => {
    // The inbox view has an internal level: back closes the open item
    // before leaving the view (its detail's own back header is suppressed).
    if (view.type === 'inbox' && $inboxView.get().selectedItemId) {
      $inboxView.set({ selectedItemId: null });
      return;
    }
    ticketApi.goBackToPrevious(shellProjectId ?? undefined);
  }, [view.type, shellProjectId]);

  // A surface root has no "up" — it shows the drawer handle instead; every
  // deeper view shows a back arrow.
  const atSurfaceRoot =
    view.type === 'all' || view.type === 'project' || (view.type === 'inbox' && inboxView.selectedItemId === null);

  // Keyboard shortcut: Cmd/Ctrl+N → new page in current project
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        const projectId =
          view.type === 'project' || view.type === 'page' || view.type === 'milestone' ? view.projectId : null;
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

  // Project routes share one persistent shell. Detail routes keep their
  // parent tab selected so moving between work, runs, review, and context
  // never loses project orientation.
  const content = (() => {
    if (view.type === 'inbox') {
      return <InboxView />;
    }
    if (view.type === 'project') {
      const tab: ProjectTab = view.tab;
      if (tab === 'home') {
        return <ProjectHome projectId={view.projectId} />;
      }
      if (tab === 'tasks') {
        return <WorkItemsList projectId={view.projectId} pageTitle="Tasks" hideChrome />;
      }
      if (tab === 'pages') {
        return <ProjectPagesTab projectId={view.projectId} />;
      }
      return <ProjectSettings projectId={view.projectId} />;
    }
    if (view.type === 'page') {
      return <PageView key={view.pageId} pageId={view.pageId} projectId={view.projectId} />;
    }
    if (view.type === 'milestone') {
      return <MilestoneDetail milestoneId={view.milestoneId} projectId={view.projectId} hideChrome={!isDesktop} />;
    }
    if (view.type === 'ticket') {
      return (
        <TicketDetail
          key={view.ticketId}
          ticketId={view.ticketId}
          onClose={handleBack}
          closeBehavior="back"
          hideTitleBar={!isDesktop}
        />
      );
    }
    return null;
  })();

  const activeProjectTab: ProjectTab | null = (() => {
    if (view.type === 'project') {
      return view.tab;
    }
    if (view.type === 'ticket' || view.type === 'milestone') {
      return 'tasks';
    }
    if (view.type === 'page') {
      return 'pages';
    }
    return null;
  })();

  return (
    <div className="flex w-full h-full">
      {/* Desktop navigation lives in the unified AppSidebar; the mobile
          overlay drawer below is the only sidebar this surface owns. */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile: header with sidebar access */}
        <div className="shrink-0 sm:hidden">
          <TopAppBar
            title={mobileHeaderTitle}
            {...(atSurfaceRoot ? { showMenu: true } : { onBack: handleBack })}
            className="bg-card"
          />
        </div>

        <div className="flex-1 min-h-0">
          <div className="h-full">
            {view.type === 'all' && <WorkAllView />}
            {shellProjectId && activeProjectTab ? (
              <ProjectShell projectId={shellProjectId} activeTab={activeProjectTab}>
                {content}
              </ProjectShell>
            ) : (
              content
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
Tickets.displayName = 'Tickets';
