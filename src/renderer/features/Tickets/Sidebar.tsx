import {
  makeStyles,
  NavDrawer,
  NavDrawerBody,
  Subtitle2,
  tokens,
} from '@fluentui/react-components';
import { Add20Regular, ChevronDown12Regular, ChevronRight12Regular, Home16Regular, MailInbox16Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { AnimatedDialog, Caption1, DialogBody, DialogContent, DialogHeader, IconButton, Tree, TreeItem, TreeItemLayout } from '@/renderer/ds';
import { $activeInbox } from '@/renderer/features/Inbox/state';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { persistedStoreApi } from '@/renderer/services/store';

import { MilestoneForm } from './MilestoneForm';
import { ProjectForm } from './ProjectForm';
import { SidebarTree } from './SidebarTree';
import { $tickets, $ticketsView, ticketApi } from './state';

const useStyles = makeStyles({
  drawer: {
    width: '260px',
    height: '100%',
    /* Fluent's NavDrawer root defaults to colorNeutralBackground4 (#EBEBEB on
       vscode-light — noticeably darker than the rest of the app). Force bg1
       to match the Settings sidebar and the rest of the app's page plane. */
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
  },
  headerTitle: {
    flex: '1 1 0',
  },
  body: {
    flex: '1 1 0',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingLeft: tokens.spacingHorizontalMNudge,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXL,
    paddingBottom: tokens.spacingVerticalXS,
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    ':hover': {
      color: tokens.colorNeutralForeground2,
    },
  },
  chevron: {
    flexShrink: 0,
    color: 'inherit',
  },
  sectionLabel: {
    flex: '1 1 0',
  },
  /**
   * Wrapper for the Home/Inbox mini-tree. Keeps it visually identical to
   * the projects tree below so Fluent's TreeItem geometry — icon column,
   * row height, hover/selection — lines up pixel-for-pixel.
   */
  pinnedTree: {
    paddingTop: '2px',
    paddingBottom: '2px',
  },
  pinnedLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: tokens.colorPaletteGreenForeground1,
    flexShrink: 0,
  },
  emptyHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
});

/** Build a unique selectedValue from the current view state. */
function viewToNavValue(view: ReturnType<typeof $ticketsView.get>): string | undefined {
  if (view.type === 'dashboard') {
return 'home';
}
  if (view.type === 'inbox') {
return view.selectedItemId ? `inbox:${view.selectedItemId}` : 'inbox';
}
  if (view.type === 'project') {
return `project:${view.projectId}`;
}
  if (view.type === 'ticket') {
return `ticket:${view.ticketId}`;
}
  if (view.type === 'page') {
return `page:${view.pageId}:${view.projectId}`;
}
  if (view.type === 'milestone') {
return `milestone:${view.milestoneId}:${view.projectId}`;
}
  if (view.type === 'board') {
return `board:${view.projectId}`;
}
  return undefined;
}

/** Lightweight collapsible section header — small gray text + chevron, like Teams. */
const SectionHeader = memo(({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) => {
  const styles = useStyles();
  return (
    <div className={styles.sectionHeader} onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <span className={styles.chevron}>
        {open ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
      </span>
      <span className={styles.sectionLabel}>{label}</span>
    </div>
  );
});
SectionHeader.displayName = 'SectionHeader';

/* ── Main sidebar ── */

export const TicketsSidebar = memo(({ onNavigate }: { onNavigate?: () => void }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const view = useStore($ticketsView);
  const pages = useStore($pages);
  const milestones = useStore($milestones);
  const tickets = useStore($tickets);
  const [formOpen, setFormOpen] = useState(false);
  const [milestoneFormProjectId, setMilestoneFormProjectId] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);

  const projects = store.projects;
  const selectedValue = viewToNavValue(view);

  const handleOpenForm = useCallback(() => setFormOpen(true), []);
  const handleCloseForm = useCallback(() => setFormOpen(false), []);
  const handleCreateMilestone = useCallback((projectId: string) => setMilestoneFormProjectId(projectId), []);
  const handleCloseMilestoneForm = useCallback(() => setMilestoneFormProjectId(null), []);
  const toggleProjects = useCallback(() => setProjectsOpen((v) => !v), []);

  // Fetch project data when expanding in the tree (without navigating)
  const handleExpandProject = useCallback((projectId: string) => {
    void pageApi.fetchPages(projectId);
    void milestoneApi.fetchMilestones(projectId);
    void ticketApi.fetchTickets(projectId);
  }, []);

  const handleGoHome = useCallback(() => {
    ticketApi.goToDashboard();
    onNavigate?.();
  }, [onNavigate]);

  const handleGoInbox = useCallback(() => {
    ticketApi.goToInbox();
    onNavigate?.();
  }, [onNavigate]);

  // Tree selection handler — parses the value prefix to navigate
  const handleTreeSelect = useCallback(
    (val: string) => {
      if (val.startsWith('board:')) {
        ticketApi.goToBoard(val.slice(6));
      } else if (val.startsWith('project:')) {
        ticketApi.goToProject(val.slice(8));
      } else if (val.startsWith('page:')) {
        const parts = val.split(':');
        const pageId = parts[1]!;
        const projectId = parts[2]!;
        ticketApi.goToPage(pageId, projectId);
      } else if (val.startsWith('milestone:')) {
        const parts = val.split(':');
        const milestoneId = parts[1]!;
        const projectId = parts[2]!;
        ticketApi.goToMilestone(milestoneId, projectId);
      } else if (val.startsWith('ticket:')) {
        ticketApi.goToTicket(val.slice(7));
      }
      onNavigate?.();
    },
    [onNavigate]
  );

  const activeInbox = useStore($activeInbox);
  const openInboxItems = useMemo(
    () => [...activeInbox].sort((a, b) => b.createdAt - a.createdAt),
    [activeInbox]
  );

  return (
    <NavDrawer
      type="inline"
      open
      selectedValue={selectedValue}
      className={styles.drawer}
      size="small"
    >
      {/* ── Header ── */}
      <div className={styles.header}>
        <Subtitle2 className={styles.headerTitle}>Projects</Subtitle2>
        <IconButton aria-label="New project" icon={<Add20Regular />} size="sm" onClick={handleOpenForm} />
      </div>

      <NavDrawerBody className={styles.body}>
        {/* ── Pinned: Home + Inbox as tree leaves so they share exact
              geometry with the projects tree below. ── */}
        <Tree aria-label="Pinned" className={styles.pinnedTree}>
          <TreeItem itemType="leaf" value="home" onClick={handleGoHome}>
            <TreeItemLayout iconBefore={<Home16Regular />}>Home</TreeItemLayout>
          </TreeItem>
          <TreeItem itemType="leaf" value="inbox" onClick={handleGoInbox}>
            <TreeItemLayout iconBefore={<MailInbox16Regular />}>
              <span className={styles.pinnedLabelRow}>
                Inbox
                {openInboxItems.length > 0 && <span className={styles.liveDot} />}
              </span>
            </TreeItemLayout>
          </TreeItem>
        </Tree>

        {/* ── Projects Tree ── */}
        <SectionHeader label="Projects" open={projectsOpen} onToggle={toggleProjects} />
        {projectsOpen && (
          projects.length === 0 ? (
            <Caption1 className={styles.emptyHint}>No projects yet</Caption1>
          ) : (
            <SidebarTree
              projects={projects}
              pages={pages}
              milestones={milestones}
              tickets={tickets}
              selectedValue={selectedValue}
              onSelect={handleTreeSelect}
              onExpandProject={handleExpandProject}
              onCreateMilestone={handleCreateMilestone}
            />
          )
        )}
      </NavDrawerBody>

      <ProjectForm open={formOpen} onClose={handleCloseForm} />
      <AnimatedDialog open={milestoneFormProjectId != null} onClose={handleCloseMilestoneForm}>
        <DialogContent>
          <DialogHeader>New Milestone</DialogHeader>
          <DialogBody>
            {milestoneFormProjectId && (
              <MilestoneForm projectId={milestoneFormProjectId} onClose={handleCloseMilestoneForm} />
            )}
          </DialogBody>
        </DialogContent>
      </AnimatedDialog>
    </NavDrawer>
  );
});
TicketsSidebar.displayName = 'TicketsSidebar';
