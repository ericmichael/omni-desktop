import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { ProjectDetail } from './ProjectDetail';
import { TicketsSidebar } from './Sidebar';
import { $ticketsView } from './state';

const TicketsContent = memo(() => {
  const view = useStore($ticketsView);

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
