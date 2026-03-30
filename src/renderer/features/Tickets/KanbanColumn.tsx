import { useDroppable } from '@dnd-kit/core';
import { memo } from 'react';

import { cn } from '@/renderer/ds';
import type { Column, Ticket } from '@/shared/types';

import { COLUMN_BADGE_COLORS, COLUMN_BG_COLORS, COLUMN_COLORS } from './ticket-constants';
import { KanbanCard } from './KanbanCard';

export const KanbanColumn = memo(({ column, tickets }: { column: Column; tickets: Ticket[] }) => {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex flex-col w-66 shrink-0 h-full rounded-lg border border-surface-border border-t-2 transition-colors',
        COLUMN_COLORS[column.id] ?? 'border-t-fg-muted',
        isOver ? 'bg-accent-500/10' : (COLUMN_BG_COLORS[column.id] ?? 'bg-surface/50')
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-fg">{column.label}</span>
          {column.gate && (
            <span className="text-[10px] text-fg-muted" title="Gated — only a human can advance tickets past this column">
              &#x1F512;
            </span>
          )}
        </div>
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
            COLUMN_BADGE_COLORS[column.id] ?? 'text-fg-muted bg-fg-muted/10'
          )}
        >
          {tickets.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 px-2 pb-2">
        {tickets.map((ticket) => (
          <KanbanCard key={ticket.id} ticket={ticket} />
        ))}
      </div>
    </div>
  );
});
KanbanColumn.displayName = 'KanbanColumn';
