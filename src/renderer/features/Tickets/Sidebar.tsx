import {
  NavDrawer,
  NavDrawerBody,
  NavItem,
  makeStyles,
  tokens,
  Subtitle2,
} from '@fluentui/react-components';
import type { OnNavItemSelectData } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Add20Regular, ChevronDown12Regular, ChevronRight12Regular, MailInbox20Regular } from '@fluentui/react-icons';

import { Caption1, IconButton } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';

import { ProjectForm } from './ProjectForm';
import { $activeTickets, $ticketsView, ticketApi } from './state';

const useStyles = makeStyles({
  drawer: {
    width: '240px',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalXS,
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
    paddingTop: tokens.spacingVerticalM,
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
  navItemContent: {
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
  if (view.type === 'inbox') return view.selectedItemId ? `inbox:${view.selectedItemId}` : 'inbox';
  if (view.type === 'project') return `project:${view.projectId}`;
  if (view.type === 'ticket') return `ticket:${view.ticketId}`;
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
  const activeTickets = useStore($activeTickets);
  const view = useStore($ticketsView);
  const [formOpen, setFormOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [activeOpen, setActiveOpen] = useState(true);

  const projects = store.projects;
  const selectedValue = viewToNavValue(view);

  const handleOpenForm = useCallback(() => setFormOpen(true), []);
  const handleCloseForm = useCallback(() => setFormOpen(false), []);
  const toggleProjects = useCallback(() => setProjectsOpen((v) => !v), []);
  const toggleActive = useCallback(() => setActiveOpen((v) => !v), []);

  const handleNavSelect = useCallback(
    (_e: unknown, data: OnNavItemSelectData) => {
      const val = data.value as string;
      if (val === 'inbox') {
        ticketApi.goToInbox();
      } else if (val.startsWith('inbox:')) {
        ticketApi.goToInbox(val.slice(6));
      } else if (val.startsWith('project:')) {
        ticketApi.goToProject(val.slice(8));
      } else if (val.startsWith('ticket:')) {
        ticketApi.goToTicket(val.slice(7));
      }
      onNavigate?.();
    },
    [onNavigate]
  );

  // Keyboard shortcut: Alt+1–9 for active tickets
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        const entry = activeTickets[num - 1];
        if (entry) {
          e.preventDefault();
          openTicketInCode(entry.ticket.id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTickets]);

  const inboxItemsMap = useStore($inboxItems);
  const openInboxItems = useMemo(
    () =>
      Object.values(inboxItemsMap)
        .filter((i) => i.status === 'open')
        .sort((a, b) => b.createdAt - a.createdAt),
    [inboxItemsMap]
  );

  return (
    <NavDrawer
      type="inline"
      open
      selectedValue={selectedValue}
      onNavItemSelect={handleNavSelect}
      className={styles.drawer}
      size="small"
    >
      {/* ── Header ── */}
      <div className={styles.header}>
        <Subtitle2 className={styles.headerTitle}>Projects</Subtitle2>
        <IconButton aria-label="New project" icon={<Add20Regular />} size="sm" onClick={handleOpenForm} />
      </div>

      <NavDrawerBody className={styles.body}>
        {/* ── Pinned ── */}
        <NavItem value="inbox" icon={<MailInbox20Regular />}>
          <span className={styles.navItemContent}>
            Inbox
            {openInboxItems.length > 0 && <span className={styles.liveDot} />}
          </span>
        </NavItem>

        {/* ── Projects ── */}
        <SectionHeader label="Projects" open={projectsOpen} onToggle={toggleProjects} />
        {projectsOpen && (
          projects.length === 0 ? (
            <Caption1 className={styles.emptyHint}>No projects yet</Caption1>
          ) : (
            projects.map((project) => (
              <NavItem key={project.id} value={`project:${project.id}`}>
                {project.label}
              </NavItem>
            ))
          )
        )}

        {/* ── Active Tickets ── */}
        <SectionHeader
          label={`Active Tickets${activeTickets.length > 0 ? ` (${activeTickets.length})` : ''}`}
          open={activeOpen}
          onToggle={toggleActive}
        />
        {activeOpen && (
          activeTickets.length === 0 ? (
            <Caption1 className={styles.emptyHint}>No active tickets</Caption1>
          ) : (
            activeTickets.map((entry) => {
              const { ticket, hasLiveTask } = entry;
              const phase = ticket.phase;
              const isRunning = phase != null && phase !== 'idle' && phase !== 'error' && phase !== 'completed';
              return (
                <NavItem key={ticket.id} value={`ticket:${ticket.id}`}>
                  <span className={styles.navItemContent}>
                    {ticket.title}
                    {(isRunning || hasLiveTask) && <span className={styles.liveDot} />}
                  </span>
                </NavItem>
              );
            })
          )
        )}
      </NavDrawerBody>

      <ProjectForm open={formOpen} onClose={handleCloseForm} />
    </NavDrawer>
  );
});
TicketsSidebar.displayName = 'TicketsSidebar';
