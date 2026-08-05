import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { $currentPrincipal } from '@/renderer/features/Teams/state';
import type { Column, ColumnId, ProjectId, Ticket, TicketId } from '@/shared/types';

import { KanbanCard } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';
import { ProjectTaskComposer } from './ProjectTaskComposer';
import { $activeMilestoneId, $assigneeFilter, $pipeline, $tickets, ticketApi } from './state';

type VisibilityFilter = 'current' | 'archived' | 'all';

export const KanbanBoard = memo(
  ({
    projectId,
    visibilityFilter = 'current',
    query = '',
  }: {
    projectId: ProjectId;
    visibilityFilter?: VisibilityFilter;
    query?: string;
  }) => {
    const pipeline = useStore($pipeline);
    const tickets = useStore($tickets);
    const activeMilestoneId = useStore($activeMilestoneId);
    const assigneeFilter = useStore($assigneeFilter);
    const currentPrincipal = useStore($currentPrincipal);

    const [activeTicket, setActiveTicket] = useState<{ ticket: Ticket; column: Column } | null>(null);
    const [newTaskColumnId, setNewTaskColumnId] = useState<ColumnId | null>(null);

    // Mouse drags on small movement; touch drags on long-press so a swipe on a
    // card still scrolls the board instead of picking the card up.
    const sensors = useSensors(
      useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
      useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
    );

    const projectTickets = useMemo(() => {
      const normalizedQuery = query.trim().toLowerCase();
      return Object.values(tickets).filter((t) => {
        if (t.projectId !== projectId) {
          return false;
        }
        if (activeMilestoneId !== 'all' && t.milestoneId !== activeMilestoneId) {
          return false;
        }
        // Assignee filter (teams): 'all' = everyone, 'me' = current principal,
        // 'unassigned' = no assignee, else a specific member's principal id.
        if (assigneeFilter === 'me') {
          if (t.assignee !== currentPrincipal) {
            return false;
          }
        } else if (assigneeFilter === 'unassigned') {
          if (t.assignee) {
            return false;
          }
        } else if (assigneeFilter !== 'all') {
          if (t.assignee !== assigneeFilter) {
            return false;
          }
        }
        if (visibilityFilter === 'current') {
          if (t.archivedAt) {
            return false;
          }
        }
        if (visibilityFilter === 'archived') {
          if (!t.archivedAt) {
            return false;
          }
        }
        return (
          !normalizedQuery ||
          t.title.toLowerCase().includes(normalizedQuery) ||
          t.description.toLowerCase().includes(normalizedQuery)
        );
      });
    }, [tickets, projectId, activeMilestoneId, assigneeFilter, currentPrincipal, visibilityFilter, query]);

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

    const handleNewTicket = useCallback((columnId: ColumnId) => setNewTaskColumnId(columnId), []);

    if (!pipeline) {
      return (
        <div className="flex items-center justify-center h-40">
          <p className="text-sm text-muted-foreground">Loading pipeline...</p>
        </div>
      );
    }

    return (
      <>
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex flex-col h-full min-h-0 min-w-0">
            <div className="flex gap-2 flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden overscroll-contain pl-2 pr-2 pt-2 pb-2 sm:gap-4 sm:pl-5 sm:pr-5 sm:pt-4 sm:pb-4">
              {pipeline.columns.map((column) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  tickets={ticketsByColumn[column.id] ?? []}
                  onNewTicket={handleNewTicket}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTicket && <KanbanCard ticket={activeTicket.ticket} isOverlay />}
          </DragOverlay>
        </DndContext>
        <ProjectTaskComposer
          projectId={projectId}
          milestoneId={activeMilestoneId !== 'all' ? activeMilestoneId : undefined}
          columnId={newTaskColumnId ?? undefined}
          open={newTaskColumnId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setNewTaskColumnId(null);
            }
          }}
        />
      </>
    );
  }
);
KanbanBoard.displayName = 'KanbanBoard';
