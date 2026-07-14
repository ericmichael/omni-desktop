import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { Navigation20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { IconButton, TopAppBar } from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { PageView } from '@/renderer/features/Pages/PageView';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { ProjectId } from '@/shared/types';

import { MilestoneDetail } from './MilestoneDetail';
import { ProjectHome } from './ProjectHome';
import { ProjectPagesTab } from './ProjectPagesTab';
import { ProjectSettings } from './ProjectSettings';
import { TicketsSidebar } from './Sidebar';
import { $ticketsView, type ProjectTab, ticketApi } from './state';
import { TicketAutopilotLaunchDialog } from './TicketAutopilotLaunchDialog';
import { TicketDetail } from './TicketDetail';
import { WorkAllView } from './WorkAllView';
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
  content: {
    height: '100%',
  },
});

/* ---------- Main export ---------- */

/**
 * The Work tab: all projects and their tasks. Lands on the global all-work
 * list; the sidebar picks a project (shell with Home · Work · Docs ·
 * Settings tabs); detail views render inside the shell. Home and Inbox are
 * separate rail tabs.
 */
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

  useEffect(() => {
    if (isDesktop) {
      setMobileNavOpen(false);
    }
  }, [isDesktop]);

  // The TopAppBar is the only header on mobile, so it titles the current view.
  const mobileHeaderTitle = useMemo(() => {
    if (view.type === 'all') {
      return 'Work';
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
      // Sub-pages title themselves; only Home carries the project name.
      if (view.tab === 'board') {
        return 'Tasks';
      }
      if (view.tab === 'pages') {
        return 'Docs';
      }
      if (view.tab === 'settings') {
        return 'Settings';
      }
      return activeProject?.label || 'Project';
    }
    return 'Work';
  }, [view, pages, milestones, activeTicket?.title, activeProject?.label]);

  const handleBack = useCallback(() => {
    ticketApi.goBackToPrevious(shellProjectId ?? undefined);
  }, [shellProjectId]);

  const handleOpenMobileNav = useCallback(() => setMobileNavOpen(true), []);
  const handleCloseMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const mobileBackHandler = view.type === 'all' ? undefined : handleBack;
  const mobileNavButton = (
    <IconButton aria-label="Open navigation" icon={<Navigation20Regular />} size="sm" onClick={handleOpenMobileNav} />
  );

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

  // There is no project tab bar (the Basecamp model): the project home is
  // the hub, and every sub-page — Tasks board, Docs, Settings, details —
  // takes over the full content plane with a breadcrumb as the way back up.
  const content = (() => {
    if (view.type === 'project') {
      const tab: ProjectTab = view.tab;
      if (tab === 'home') {
        return <ProjectHome projectId={view.projectId} />;
      }
      if (tab === 'board') {
        return <WorkItemsList projectId={view.projectId} pageTitle="Tasks" hideChrome={!isDesktop} />;
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
            className={isGlass ? 'omni-glass-mobile-top-app-bar' : 'bg-surface-raised'}
          />
        </div>

        <div className={mergeClasses(styles.contentArea, isGlass && styles.contentAreaGlass)}>
          <div className={styles.content}>
            {view.type === 'all' && <WorkAllView />}
            {content}
          </div>
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

      <TicketAutopilotLaunchDialog />
    </div>
  );
});
Tickets.displayName = 'Tickets';
