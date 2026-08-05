import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import type { Column, ColumnId, Ticket } from '@/shared/types';

import { KanbanCard } from './KanbanCard';
import { getColumnColors } from './ticket-constants';

type KanbanColumnProps = {
  column: Column;
  tickets: Ticket[];
  onNewTicket?: (columnId: ColumnId) => void;
};

export const KanbanColumn = memo(({ column, tickets, onNewTicket }: KanbanColumnProps) => {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
  });

  const colors = useMemo(() => getColumnColors(column.id), [column.id]);

  const handleNew = useCallback(() => {
    onNewTicket?.(column.id);
  }, [onNewTicket, column.id]);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col w-56 shrink-0 h-full rounded-lg border border-border border-t-2 transition-colors duration-150 sm:w-64',
        !isOver && colors.columnClassName,
        isOver && 'bg-primary/10'
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between pl-4 pr-4 pt-2 pb-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{column.label}</span>
          {column.gate && (
            <span
              className="text-xs text-muted-foreground"
              title="Gated — only a human can advance tasks past this column"
            >
              &#x1F512;
            </span>
          )}
        </div>
        <Badge variant="secondary" className={colors.badgeClassName}>
          {tickets.length}
        </Badge>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pl-2 pr-2 pb-2">
        {tickets.map((ticket) => (
          <KanbanCard key={ticket.id} ticket={ticket} />
        ))}
      </div>

      {/* + New */}
      {onNewTicket && (
        <Button
          type="button"
          variant="ghost"
          className="flex items-center gap-1 w-full pl-4 pr-4 pt-1.5 pb-1.5 border-0 bg-transparent rounded-lg cursor-pointer text-muted-foreground text-xs transition-colors duration-100 hover:bg-accent hover:text-foreground"
          onClick={handleNew}
        >
          <Plus />
          New
        </Button>
      )}
    </div>
  );
});
KanbanColumn.displayName = 'KanbanColumn';
