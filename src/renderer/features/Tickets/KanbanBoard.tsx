import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';

import type { Column, ColumnId, ProjectId, Ticket, TicketId } from '@/shared/types';

import { KanbanCard } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';
import { $activeMilestoneId, $pipeline, $tickets, ticketApi } from './state';

const useStyles = makeStyles({
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '160px',
  },
  loadingText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  board: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    height: '100%',
    overflowX: 'auto',
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    '@media (min-width: 640px)': {
      gap: tokens.spacingHorizontalM,
      paddingLeft: tokens.spacingHorizontalL,
      paddingRight: tokens.spacingHorizontalL,
      paddingTop: tokens.spacingVerticalM,
      paddingBottom: tokens.spacingVerticalM,
    },
  },
});

export const KanbanBoard = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const pipeline = useStore($pipeline);
  const tickets = useStore($tickets);
  const activeMilestoneId = useStore($activeMilestoneId);

  const [activeTicket, setActiveTicket] = useState<{ ticket: Ticket; column: Column } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const projectTickets = useMemo(
    () =>
      Object.values(tickets).filter(
        (t) => t.projectId === projectId && (activeMilestoneId === 'all' || t.milestoneId === activeMilestoneId)
      ),
    [tickets, projectId, activeMilestoneId]
  );

  const ticketsByColumn = useMemo(() => {
    const map: Record<string, Ticket[]> = {};
    if (!pipeline) {
      return map;
    }
    for (const col of pipeline.columns) {
      map[col.id] = [];
    }
    const firstColumnId = pipeline.columns[0]?.id;
    for (const ticket of projectTickets) {
      const colId = ticket.columnId ?? firstColumnId;
      if (colId && map[colId]) {
        map[colId].push(ticket);
      }
    }
    // Sort tickets within each column by createdAt
    for (const colId of Object.keys(map)) {
      map[colId]?.sort((a, b) => a.createdAt - b.createdAt);
    }
    return map;
  }, [pipeline, projectTickets]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const ticketId = event.active.id as TicketId;
      const ticket = tickets[ticketId];
      if (!ticket || !pipeline) {
        return;
      }
      const colId = ticket.columnId ?? pipeline.columns[0]?.id;
      const column = pipeline.columns.find((c) => c.id === colId);
      if (column) {
        setActiveTicket({ ticket, column });
      }
    },
    [tickets, pipeline]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTicket(null);
      const { active, over } = event;
      if (!over) {
        return;
      }
      const ticketId = active.id as TicketId;
      const newColumnId = over.id as string;
      const ticket = tickets[ticketId];
      if (!ticket) {
        return;
      }
      const currentColumnId = ticket.columnId ?? pipeline?.columns[0]?.id;
      if (currentColumnId !== newColumnId) {
        ticketApi.moveTicketToColumn(ticketId, newColumnId);
      }
    },
    [tickets, pipeline]
  );

  const handleDragCancel = useCallback(() => {
    setActiveTicket(null);
  }, []);

  const handleNewTicket = useCallback(
    async (columnId: ColumnId) => {
      const ticket = await ticketApi.addTicket({
        projectId,
        milestoneId: activeMilestoneId !== 'all' ? activeMilestoneId : undefined,
        title: 'Untitled',
        description: '',
        priority: 'medium',
        blockedBy: [],
      });
      // Place in the target column
      if (columnId !== pipeline?.columns[0]?.id) {
        void ticketApi.moveTicketToColumn(ticket.id, columnId);
      }
      // Navigate to the ticket detail so user can fill in details
      ticketApi.goToTicket(ticket.id);
    },
    [projectId, activeMilestoneId, pipeline]
  );

  if (!pipeline) {
    return (
      <div className={styles.loading}>
        <p className={styles.loadingText}>Loading pipeline...</p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className={styles.board}>
        {pipeline.columns.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            tickets={ticketsByColumn[column.id] ?? []}
            onNewTicket={handleNewTicket}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTicket && <KanbanCard ticket={activeTicket.ticket} isOverlay />}
      </DragOverlay>
    </DndContext>
  );
});
KanbanBoard.displayName = 'KanbanBoard';
