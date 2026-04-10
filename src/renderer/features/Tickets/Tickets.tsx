import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronRight20Regular, Folder20Regular, Add20Regular } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import { Badge, Body1, Caption1, CounterBadge, EmptyState, FAB, Tab, TabList, TopAppBar } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { IceboxList } from '@/renderer/features/Inbox/IceboxList';
import { InboxDetail } from '@/renderer/features/Inbox/InboxDetail';
import { InboxList } from '@/renderer/features/Inbox/InboxList';
import { inboxApi } from '@/renderer/features/Inbox/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId } from '@/shared/types';

import { ProjectDetail } from './ProjectDetail';
import { ProjectForm } from './ProjectForm';
import { TicketsSidebar } from './Sidebar';
import { TicketDetail } from './TicketDetail';
import { $activeWipTickets, $ticketsView, $wipDialogPendingTicket, ticketApi } from './state';
import { WipLimitDialog } from './WipLimitDialog';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
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
    display: 'none',
    '@media (min-width: 640px)': {
      display: 'block',
      height: '100%',
    },
  },
  mobileContent: {
    height: '100%',
    '@media (min-width: 640px)': {
      display: 'none',
    },
  },
  mobileProjectList: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  projectListScroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  projectListItems: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  projectBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '14px',
    paddingBottom: '14px',
    textAlign: 'left',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    borderRadius: tokens.borderRadiusLarge,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
    },
  },
  projectIcon: {
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1Hover,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  projectIconText: {
    color: tokens.colorNeutralForeground2,
  },
  projectTextCol: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minWidth: 0,
    gap: '2px',
  },
  projectActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: {
    color: tokens.colorNeutralForeground3,
  },
});

/* ---------- Shared sub-views ---------- */

const InboxView = memo(() => {
  const view = useStore($ticketsView);
  const selectedId = view.type === 'inbox' ? view.selectedItemId ?? null : null;
  const [showIcebox, setShowIcebox] = useState(false);

  const handleSelect = useCallback((id: InboxItemId | null) => {
    ticketApi.goToInbox(id ?? undefined);
  }, []);

  const handleBack = useCallback(() => {
    ticketApi.goToInbox();
  }, []);

  const handleShowIcebox = useCallback(() => {
    void inboxApi.fetchIceboxItems();
    setShowIcebox(true);
  }, []);

  const handleHideIcebox = useCallback(() => {
    setShowIcebox(false);
  }, []);

  if (showIcebox) {
    return <IceboxList onBack={handleHideIcebox} />;
  }
  if (selectedId) {
    return <InboxDetail itemId={selectedId} onBack={handleBack} />;
  }
  return <InboxList selectedId={selectedId} onSelect={handleSelect} onShowIcebox={handleShowIcebox} />;
});
InboxView.displayName = 'InboxView';

/* ---------- Mobile project list ---------- */

const MobileProjectList = memo(({ onNewProject }: { onNewProject: () => void }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const projects = store.projects;

  const ticketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ticket of store.tickets) {
      counts[ticket.projectId] = (counts[ticket.projectId] ?? 0) + 1;
    }
    return counts;
  }, [store.tickets]);

  return (
    <div className={styles.mobileProjectList}>
      <div className={styles.projectListScroll}>
        {projects.length === 0 ? (
          <EmptyState title="No projects yet" description="Tap + to create one" />
        ) : (
          <div className={styles.projectListItems}>
            {projects.map((project) => {
              const segments = project.workspaceDir.split('/').filter(Boolean);
              const shortPath = segments.slice(-2).join('/');
              const count = ticketCounts[project.id] ?? 0;
              return (
                <button
                  key={project.id}
                  onClick={() => ticketApi.goToProject(project.id)}
                  className={styles.projectBtn}
                >
                  <span className={styles.projectIcon}>
                    <Folder20Regular className={styles.projectIconText} />
                  </span>
                  <div className={styles.projectTextCol}>
                    <Body1 className={styles.truncate}>{project.label}</Body1>
                    <Caption1 className={styles.truncate}>{shortPath}</Caption1>
                  </div>
                  <div className={styles.projectActions}>
                    {count > 0 && (
                      <Badge color="blue">{count}</Badge>
                    )}
                    <ChevronRight20Regular className={styles.chevron} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <FAB icon={<Add20Regular style={{ width: 22, height: 22 }} />} onClick={onNewProject} aria-label="New project" />
    </div>
  );
});
MobileProjectList.displayName = 'MobileProjectList';

/* ---------- Mobile tab type ---------- */

type MobileTab = 'inbox' | 'projects';

/* ---------- Main export ---------- */

export const Tickets = memo(() => {
  const styles = useStyles();
  const view = useStore($ticketsView);
  const inboxItemsMap = useStore($inboxItems);
  const [mobileTab, setMobileTab] = useState<MobileTab>(view.type === 'inbox' ? 'inbox' : 'projects');
  const [formOpen, setFormOpen] = useState(false);

  const openInboxCount = useMemo(
    () => Object.values(inboxItemsMap).filter((i) => i.status === 'open').length,
    [inboxItemsMap]
  );

  const isViewingProject = view.type === 'project';

  const handleBack = useCallback(() => {
    ticketApi.goToDashboard();
  }, []);

  return (
    <div className={styles.root}>
      {/* Desktop: sidebar always visible */}
      <div className={styles.desktopSidebar}>
        <TicketsSidebar />
      </div>

      <div className={styles.mainColumn}>
        {/* Mobile: tab bar or back header */}
        <div className={styles.mobileHeader}>
          {mobileTab === 'projects' && isViewingProject ? (
            /* Back header when viewing a project detail */
            <TopAppBar title="Projects" onBack={handleBack} className="bg-surface-raised" />
          ) : (
            /* Tab bar: Inbox / Projects */
            <div className={styles.mobileTabBar}>
              <TabList
                selectedValue={mobileTab}
                onTabSelect={(_e, data) => {
                  const tab = data.value as MobileTab;
                  setMobileTab(tab);
                  if (tab === 'inbox') ticketApi.goToInbox();
                  else ticketApi.goToDashboard();
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

        {/* Content */}
        <div className={styles.contentArea}>
          {/* Desktop content — driven by $ticketsView */}
          <div className={styles.desktopContent}>
            {view.type === 'inbox' && <InboxView />}
            {view.type === 'project' && <ProjectDetail projectId={view.projectId} />}
            {view.type === 'ticket' && <TicketDetail ticketId={view.ticketId} onClose={() => ticketApi.goToDashboard()} />}
            {view.type === 'dashboard' && (
              <EmptyState title="Select a project to get started" description="Or create a new project from the sidebar" />
            )}
          </div>

          {/* Mobile content — driven by mobileTab + $ticketsView */}
          <div className={styles.mobileContent}>
            {mobileTab === 'inbox' && <InboxView />}
            {mobileTab === 'projects' && (
              view.type === 'ticket'
                ? <TicketDetail ticketId={view.ticketId} onClose={() => ticketApi.goToDashboard()} />
                : isViewingProject
                  ? <ProjectDetail projectId={view.projectId} />
                  : <MobileProjectList onNewProject={() => setFormOpen(true)} />
            )}
          </div>
        </div>
      </div>

      {formOpen && <ProjectForm open={formOpen} onClose={() => setFormOpen(false)} />}
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

  if (!pendingTicket) return null;

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
