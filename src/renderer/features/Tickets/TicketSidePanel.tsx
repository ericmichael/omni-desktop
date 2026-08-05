import { Maximize2, X } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/renderer/ds/ui/sheet';
import type { TicketId } from '@/shared/types';

import { ticketApi } from './state';
import { TicketDetail } from './TicketDetail';

type TicketSidePanelProps = {
  ticketId: TicketId;
  onClose: () => void;
};

export const TicketSidePanel = memo(({ ticketId, onClose }: TicketSidePanelProps) => {
  const handleOpenFullPage = useCallback(() => {
    ticketApi.goToTicket(ticketId);
  }, [ticketId]);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="h-full w-120 max-w-full gap-0 p-0 sm:max-w-120" showCloseButton={false}>
        <SheetHeader className="sr-only">
          <SheetTitle>Task details</SheetTitle>
        </SheetHeader>
        <div className="flex items-center justify-end gap-1 pl-2 pr-2 pt-1 pb-1 border-b border-border shrink-0">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Open full page" onClick={handleOpenFullPage}>
            <Maximize2 />
          </Button>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close panel">
              <X />
            </Button>
          </SheetClose>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <TicketDetail key={ticketId} ticketId={ticketId} compact onClose={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  );
});
TicketSidePanel.displayName = 'TicketSidePanel';
