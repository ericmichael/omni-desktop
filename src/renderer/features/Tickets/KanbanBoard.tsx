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

import type { Column, ProjectId, Ticket, TicketId } from '@/shared/types';

import { KanbanCard } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';
import { $activeInitiativeId, $pipeline, $tickets, ticketApi } from './state';

export const KanbanBoard = memo(({ projectId }: { projectId: ProjectId }) => {
  const pipeline = useStore($pipeline);
  const tickets = useStore($tickets);
  const activeInitiativeId = useStore($activeInitiativeId);

  const [activeTicket, setActiveTicket] = useState<{ ticket: Ticket; column: Column } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const projectTickets = useMemo(
    () =>
      Object.values(tickets).filter(
        (t) => t.projectId === projectId && (activeInitiativeId === 'all' || t.initiativeId === activeInitiativeId)
      ),
    [tickets, projectId, activeInitiativeId]
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

  if (!pipeline) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-fg-muted">Loading pipeline...</p>
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
      <div className="flex gap-3 h-full overflow-x-auto px-4 py-3">
        {pipeline.columns.map((column) => (
          <KanbanColumn key={column.id} column={column} tickets={ticketsByColumn[column.id] ?? []} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTicket && <KanbanCard ticket={activeTicket.ticket} isOverlay />}
      </DragOverlay>
    </DndContext>
  );
});
KanbanBoard.displayName = 'KanbanBoard';
