import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { FleetProjectDetail } from './FleetProjectDetail';
import { FleetSidebar } from './FleetSidebar';
import { FleetTicketDetail } from './FleetTicketDetail';
import { $fleetView } from './state';

const FleetContent = memo(() => {
  const view = useStore($fleetView);

  if (view.type === 'ticket') {
    return <FleetTicketDetail ticketId={view.ticketId} />;
  }

  if (view.type === 'project') {
    return <FleetProjectDetail projectId={view.projectId} />;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full">
      <p className="text-fg-muted text-sm">Select a project to get started</p>
      <p className="text-fg-subtle text-xs">Or create a new project from the sidebar</p>
    </div>
  );
});
FleetContent.displayName = 'FleetContent';

export const Fleet = memo(() => {
  return (
    <div className="flex w-full h-full">
      <FleetSidebar />
      <div className="flex-1 min-w-0">
        <FleetContent />
      </div>
    </div>
  );
});
Fleet.displayName = 'Fleet';
