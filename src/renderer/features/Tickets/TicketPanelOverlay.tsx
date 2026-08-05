import { useStore } from '@nanostores/react';
import { Files, Info, X } from 'lucide-react';
import { memo } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import type { TicketId } from '@/shared/types';

import { $tickets } from './state';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketOverviewTab } from './TicketOverviewTab';

export type TicketPanel = 'overview' | 'artifacts';

const PANEL_META: Record<TicketPanel, { label: string; icon: typeof Info }> = {
  overview: { label: 'Overview', icon: Info },
  artifacts: { label: 'Results', icon: Files },
};

const PanelContent = memo(({ panel, ticketId }: { panel: TicketPanel; ticketId: TicketId }) => {
  const tickets = useStore($tickets);
  const ticket = ticketId ? tickets[ticketId] : undefined;

  if (panel === 'overview') {
    if (!ticket) {
      return null;
    }
    return (
      <div className="p-8 overflow-y-auto h-full">
        <TicketOverviewTab ticket={ticket} />
      </div>
    );
  }
  return <TicketArtifactsTab ticketId={ticketId} />;
});
PanelContent.displayName = 'PanelContent';

export const TicketPanelOverlay = memo(
  ({ panel, ticketId, onClose }: { panel: TicketPanel | null; ticketId: TicketId; onClose: () => void }) => {
    return (
      <Dialog open={panel !== null} onOpenChange={(open) => !open && onClose()}>
        {panel && (
          <DialogContent
            className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden p-0"
            showCloseButton={false}
          >
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-border bg-card pl-4 pr-4 pt-2 pb-2">
                <DialogHeader className="flex-row items-center gap-2 text-left text-sm text-foreground/80">
                  {(() => {
                    const Icon = PANEL_META[panel].icon;
                    return <Icon className="size-4" />;
                  })()}
                  <DialogTitle className="text-sm">{PANEL_META[panel].label}</DialogTitle>
                  <DialogDescription className="sr-only">
                    Task {PANEL_META[panel].label.toLowerCase()}
                  </DialogDescription>
                </DialogHeader>
                <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close panel">
                  <X className="size-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                <PanelContent panel={panel} ticketId={ticketId} />
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    );
  }
);
TicketPanelOverlay.displayName = 'TicketPanelOverlay';
