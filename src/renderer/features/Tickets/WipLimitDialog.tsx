import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { Stop20Filled } from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

import { AnimatedDialog, Badge, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Ticket, TicketId } from '@/shared/types';

import { ticketApi } from './state';
import { APPETITE_COLORS, APPETITE_LABELS, PHASE_COLORS, PHASE_LABELS } from './ticket-constants';

const useStyles = makeStyles({
  description: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  pendingName: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightMedium,
  },
  ticketList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalM,
  },
  ticketCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalM,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  ticketInfo: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minWidth: 0,
    gap: '2px',
  },
  ticketTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  stopIcon: {
    marginRight: '4px',
  },
});

type WipLimitDialogProps = {
  /** The ticket the user is trying to start. */
  pendingTicket: Ticket;
  /** Currently active WIP tickets. */
  activeTickets: Ticket[];
  /** Called when the user picks a ticket to drop. */
  onDrop: (droppedTicketId: TicketId) => void;
  /** Called when the user abandons the attempt. */
  onCancel: () => void;
};

export const WipLimitDialog = memo(
  ({ pendingTicket, activeTickets, onDrop, onCancel }: WipLimitDialogProps) => {
    const styles = useStyles();
    const wipLimit = persistedStoreApi.$atom.get().wipLimit ?? 3;

    const handleDrop = useCallback(
      (ticketId: TicketId) => {
        void ticketApi.stopSupervisor(ticketId);
        onDrop(ticketId);
      },
      [onDrop]
    );

    return (
      <AnimatedDialog open onClose={onCancel}>
        <DialogContent>
          <DialogHeader>
            WIP limit reached ({wipLimit} of {wipLimit})
          </DialogHeader>
          <DialogBody>
            <p className={styles.description}>
              To start <span className={styles.pendingName}>{pendingTicket.title}</span>,
              stop one of your active items.
            </p>
            <div className={styles.ticketList}>
              {activeTickets.map((ticket) => (
                <div key={ticket.id} className={styles.ticketCard}>
                  <div className={styles.ticketInfo}>
                    <span className={styles.ticketTitle}>{ticket.title}</span>
                    <div className={styles.badgeRow}>
                      {ticket.phase && (
                        <Badge color={PHASE_COLORS[ticket.phase] ?? 'default'}>
                          {PHASE_LABELS[ticket.phase] ?? ticket.phase}
                        </Badge>
                      )}
                      {ticket.shaping?.appetite && (
                        <Badge color={APPETITE_COLORS[ticket.shaping.appetite]}>
                          {APPETITE_LABELS[ticket.shaping.appetite]}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button size="sm" variant="destructive" onClick={() => handleDrop(ticket.id)}>
                    <Stop20Filled style={{ width: 12, height: 12 }} className={styles.stopIcon} />
                    Stop
                  </Button>
                </div>
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Never mind
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
WipLimitDialog.displayName = 'WipLimitDialog';
