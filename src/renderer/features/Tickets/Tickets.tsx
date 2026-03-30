import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';

import { InboxDetail } from '@/renderer/features/Inbox/InboxDetail';
import { InboxList } from '@/renderer/features/Inbox/InboxList';
import type { InboxItemId } from '@/shared/types';

import { ProjectDetail } from './ProjectDetail';
import { TicketsSidebar } from './Sidebar';
import { $ticketsView, ticketApi } from './state';

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

const TicketsContent = memo(() => {
  const view = useStore($ticketsView);

  if (view.type === 'inbox') {
    return <InboxView />;
  }
  if (view.type === 'project') {
    return <ProjectDetail projectId={view.projectId} />;
  }
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full">
      <p className="text-fg-muted text-sm">Select a project to get started</p>
      <p className="text-fg-subtle text-xs">Or create a new project from the sidebar</p>
    </div>
  );
});
TicketsContent.displayName = 'TicketsContent';

export const Tickets = memo(() => {
  return (
    <div className="flex w-full h-full">
      <TicketsSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <TicketsContent />
        </div>
      </div>
    </div>
  );
});
Tickets.displayName = 'Tickets';
