import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiCaretRightBold, PiFolderBold, PiPlusBold } from 'react-icons/pi';

import { Badge, cn, EmptyState, FAB, TopAppBar } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { InboxDetail } from '@/renderer/features/Inbox/InboxDetail';
import { InboxList } from '@/renderer/features/Inbox/InboxList';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItemId } from '@/shared/types';

import { ProjectDetail } from './ProjectDetail';
import { ProjectForm } from './ProjectForm';
import { TicketsSidebar } from './Sidebar';
import { $ticketsView, ticketApi } from './state';

/* ---------- Shared sub-views ---------- */

const InboxView = memo(() => {
  const view = useStore($ticketsView);
  const selectedId = view.type === 'inbox' ? view.selectedItemId ?? null : null;

  const handleSelect = useCallback((id: InboxItemId | null) => {
    ticketApi.goToInbox(id ?? undefined);
  }, []);

  const handleBack = useCallback(() => {
    ticketApi.goToInbox();
  }, []);

  if (selectedId) {
    return <InboxDetail itemId={selectedId} onBack={handleBack} />;
  }
  return <InboxList selectedId={selectedId} onSelect={handleSelect} />;
});
InboxView.displayName = 'InboxView';

/* ---------- Mobile project list ---------- */

const MobileProjectList = memo(({ onNewProject }: { onNewProject: () => void }) => {
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
    <div className="relative flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {projects.length === 0 ? (
          <EmptyState title="No projects yet" description="Tap + to create one" />
        ) : (
          <div className="flex flex-col gap-1">
            {projects.map((project) => {
              const segments = project.workspaceDir.split('/').filter(Boolean);
              const shortPath = segments.slice(-2).join('/');
              const count = ticketCounts[project.id] ?? 0;
              return (
                <button
                  key={project.id}
                  onClick={() => ticketApi.goToProject(project.id)}
                  className="flex items-center gap-3 w-full px-3 py-3.5 text-left transition-colors rounded-xl hover:bg-white/5 active:bg-white/10"
                >
                  <span className="size-9 rounded-lg bg-surface-overlay flex items-center justify-center shrink-0">
                    <PiFolderBold size={18} className="text-fg-muted" />
                  </span>
                  <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span className="text-sm font-medium text-fg truncate">{project.label}</span>
                    <span className="text-xs text-fg-subtle truncate">{shortPath}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {count > 0 && (
                      <Badge color="blue">{count}</Badge>
                    )}
                    <PiCaretRightBold size={12} className="text-fg-muted/40" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <FAB icon={<PiPlusBold size={22} />} onClick={onNewProject} aria-label="New project" />
    </div>
  );
});
MobileProjectList.displayName = 'MobileProjectList';

/* ---------- Mobile tab type ---------- */

type MobileTab = 'inbox' | 'projects';

/* ---------- Main export ---------- */

export const Tickets = memo(() => {
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
    <div className="flex w-full h-full">
      {/* Desktop: sidebar always visible */}
      <div className="hidden sm:block">
        <TicketsSidebar />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile: tab bar or back header */}
        <div className="sm:hidden shrink-0">
          {mobileTab === 'projects' && isViewingProject ? (
            /* Back header when viewing a project detail */
            <TopAppBar title="Projects" onBack={handleBack} className="bg-surface-raised" />
          ) : (
            /* Tab bar: Inbox / Projects */
            <div className="flex border-b border-surface-border bg-surface-raised">
              <button
                onClick={() => { setMobileTab('inbox'); ticketApi.goToInbox(); }}
                className={cn(
                  'flex-1 py-2.5 text-center text-sm font-medium transition-colors relative',
                  mobileTab === 'inbox' ? 'text-fg' : 'text-fg-muted'
                )}
              >
                Inbox
                {openInboxCount > 0 && (
                  <span className="ml-1.5 inline-flex min-w-[16px] h-4 px-1 rounded-full text-xs font-bold leading-4 text-center bg-accent-600 text-white">
                    {openInboxCount}
                  </span>
                )}
                {mobileTab === 'inbox' && (
                  <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-accent-600 rounded-t-full" />
                )}
              </button>
              <button
                onClick={() => { setMobileTab('projects'); ticketApi.goToDashboard(); }}
                className={cn(
                  'flex-1 py-2.5 text-center text-sm font-medium transition-colors relative',
                  mobileTab === 'projects' ? 'text-fg' : 'text-fg-muted'
                )}
              >
                Projects
                {mobileTab === 'projects' && (
                  <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-accent-600 rounded-t-full" />
                )}
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0">
          {/* Desktop content — driven by $ticketsView */}
          <div className="hidden sm:block h-full">
            {view.type === 'inbox' && <InboxView />}
            {view.type === 'project' && <ProjectDetail projectId={view.projectId} />}
            {view.type === 'dashboard' && (
              <EmptyState title="Select a project to get started" description="Or create a new project from the sidebar" />
            )}
          </div>

          {/* Mobile content — driven by mobileTab + $ticketsView */}
          <div className="sm:hidden h-full">
            {mobileTab === 'inbox' && <InboxView />}
            {mobileTab === 'projects' && (
              isViewingProject
                ? <ProjectDetail projectId={view.projectId} />
                : <MobileProjectList onNewProject={() => setFormOpen(true)} />
            )}
          </div>
        </div>
      </div>

      {formOpen && <ProjectForm open={formOpen} onClose={() => setFormOpen(false)} />}
    </div>
  );
});
Tickets.displayName = 'Tickets';
