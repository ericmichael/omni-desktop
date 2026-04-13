import { useDraggable } from '@dnd-kit/core';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { memo, useCallback } from 'react';
import { ArrowSync20Regular, Open20Regular, ReOrderDotsVertical20Regular, Play20Filled } from '@fluentui/react-icons';

import { Badge, Body1, IconButton } from '@/renderer/ds';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Ticket, TicketPhase } from '@/shared/types';

import { APPETITE_COLORS, APPETITE_LABELS, PHASE_COLORS, PHASE_LABELS, RESOLUTION_COLORS, RESOLUTION_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';
import { ticketApi } from './state';

const canStart = (phase: TicketPhase | undefined) => !phase || !isActivePhase(phase);

const useStyles = makeStyles({
  card: {
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '10px',
    transitionProperty: 'box-shadow',
    transitionDuration: '150ms',
  },
  overlay: {
    boxShadow: tokens.shadow16,
  },
  dragging: {
    opacity: 0.3,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
  },
  dragHandle: {
    flexShrink: 0,
    marginTop: '2px',
    cursor: 'grab',
    color: tokens.colorNeutralForeground3,
    touchAction: 'none',
    ':active': { cursor: 'grabbing' },
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  titleBtn: {
    flex: '1 1 0',
    minWidth: 0,
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    padding: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '6px',
  },
  badges: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    flex: '1 1 0',
    minWidth: 0,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
});

export const KanbanCard = memo(
  ({ ticket, isOverlay }: { ticket: Ticket; isOverlay?: boolean }) => {
    const styles = useStyles();
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: ticket.id,
      disabled: isOverlay,
    });

    const handleClick = useCallback(() => {
      openTicketInCode(ticket.id);
    }, [ticket.id]);

    const handleStart = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        openTicketInCode(ticket.id);
        ticketApi.startSupervisor(ticket.id);
      },
      [ticket.id]
    );

    const handleOpen = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        ticketApi.ensureSupervisorInfra(ticket.id);
        openTicketInCode(ticket.id);
      },
      [ticket.id]
    );

    const phase = ticket.phase;

    return (
      <div
        ref={isOverlay ? undefined : setNodeRef}
        className={mergeClasses(
          styles.card,
          isOverlay && styles.overlay,
          isDragging && !isOverlay && styles.dragging
        )}
      >
        <div className={styles.titleRow}>
          {!isOverlay && (
            <div {...listeners} {...attributes} className={styles.dragHandle}>
              <ReOrderDotsVertical20Regular style={{ width: 16, height: 16 }} />
            </div>
          )}
          <Body1 as="button" onClick={handleClick} className={styles.titleBtn}>
            {ticket.title}
          </Body1>
        </div>

        <div className={styles.badgeRow}>
          <div className={styles.badges}>
            <Badge color={TICKET_PRIORITY_COLORS[ticket.priority]}>
              {TICKET_PRIORITY_LABELS[ticket.priority]}
            </Badge>
            {ticket.shaping?.appetite && (
              <Badge color={APPETITE_COLORS[ticket.shaping.appetite]}>
                {APPETITE_LABELS[ticket.shaping.appetite]}
              </Badge>
            )}
            {/* Resolution badge omitted — column placement already conveys resolved status. */}
            {phase && phase !== 'idle' && !ticket.resolution && (
              <Badge color={PHASE_COLORS[phase] ?? 'default'}>
                {isActivePhase(phase) && <ArrowSync20Regular style={{ width: 16, height: 16 }} />}
                {PHASE_LABELS[phase] ?? phase}
              </Badge>
            )}
          </div>
          {canStart(phase) && (
            <div className={styles.actions}>
              <IconButton icon={<Open20Regular />} size="sm" onClick={handleOpen} aria-label="Chat" />
              <IconButton icon={<Play20Filled />} size="sm" onClick={handleStart} aria-label="Autopilot" />
            </div>
          )}
        </div>
      </div>
    );
  }
);
KanbanCard.displayName = 'KanbanCard';
