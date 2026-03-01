import { memo, useCallback, useMemo, useState } from 'react';
import { PiCheckCircleBold, PiCodeBold, PiPlusBold, PiTrashFill } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { FleetChecklistItem, FleetColumn, FleetColumnId, FleetPipeline, FleetTicket } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './fleet-constants';
import { fleetApi } from './state';

type FleetTicketPlanTabProps = {
  ticket: FleetTicket;
  pipeline: FleetPipeline | null;
};

function checklistToMarkdown(columns: FleetColumn[], checklist: Record<string, FleetChecklistItem[]>): string {
  return columns
    .map((col) => {
      const items = checklist[col.id] ?? [];
      const lines = items.map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`);
      return `## ${col.label}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

function markdownToChecklist(md: string, columns: FleetColumn[]): Record<string, FleetChecklistItem[]> {
  const result: Record<string, FleetChecklistItem[]> = {};
  for (const col of columns) {
    result[col.id] = [];
  }

  const labelToId = new Map<string, string>();
  for (const col of columns) {
    labelToId.set(col.label.trim().toLowerCase(), col.id);
  }

  let currentColId: string | null = null;
  for (const line of md.split('\n')) {
    const headingMatch = /^## (.+)$/.exec(line);
    if (headingMatch) {
      const label = (headingMatch[1] ?? '').trim().toLowerCase();
      currentColId = labelToId.get(label) ?? null;
      continue;
    }

    if (!currentColId) {
      continue;
    }

    const itemMatch = /^- \[([ xX])\] (.+)$/.exec(line);
    if (itemMatch) {
      result[currentColId]?.push({
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: (itemMatch[2] ?? '').trim(),
        completed: itemMatch[1] !== ' ',
      });
      continue;
    }

    const bareMatch = /^- (.+)$/.exec(line);
    if (bareMatch) {
      result[currentColId]?.push({
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: (bareMatch[1] ?? '').trim(),
        completed: false,
      });
    }
  }

  return result;
}

export const FleetTicketPlanTab = memo(({ ticket, pipeline }: FleetTicketPlanTabProps) => {
  const [newChecklistText, setNewChecklistText] = useState<Record<string, string>>({});
  const [editingChecklistMd, setEditingChecklistMd] = useState(false);
  const [checklistMd, setChecklistMd] = useState('');

  const checklistColumns = useMemo(() => {
    if (!pipeline) {
      return [];
    }
    const currentColId = ticket.columnId;
    const ordered = [...pipeline.columns];
    if (currentColId) {
      ordered.sort((a, b) => {
        if (a.id === currentColId) {
          return -1;
        }
        if (b.id === currentColId) {
          return 1;
        }
        return 0;
      });
    }
    return ordered;
  }, [pipeline, ticket]);

  const handleToggleChecklistItem = useCallback(
    (columnId: string, itemId: string) => {
      fleetApi.toggleChecklistItem(ticket.id, columnId, itemId);
    },
    [ticket.id]
  );

  const handleNewChecklistTextChange = useCallback((columnId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    setNewChecklistText((prev) => ({ ...prev, [columnId]: e.target.value }));
  }, []);

  const handleAddChecklistItem = useCallback(
    (columnId: string) => {
      const text = (newChecklistText[columnId] ?? '').trim();
      if (!text) {
        return;
      }
      const newItem: FleetChecklistItem = {
        id: `chk-${Date.now()}`,
        text,
        completed: false,
      };
      const existing = ticket.checklist[columnId] ?? [];
      fleetApi.updateChecklist(ticket.id, columnId, [...existing, newItem]);
      setNewChecklistText((prev) => ({ ...prev, [columnId]: '' }));
    },
    [ticket.id, ticket.checklist, newChecklistText]
  );

  const handleChecklistKeyDown = useCallback(
    (columnId: string, e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleAddChecklistItem(columnId);
      }
    },
    [handleAddChecklistItem]
  );

  const handleRemoveChecklistItem = useCallback(
    (columnId: string, itemId: string) => {
      const existing = ticket.checklist[columnId] ?? [];
      fleetApi.updateChecklist(
        ticket.id,
        columnId,
        existing.filter((item) => item.id !== itemId)
      );
    },
    [ticket.id, ticket.checklist]
  );

  const handleStartEditChecklistMd = useCallback(() => {
    if (pipeline) {
      setChecklistMd(checklistToMarkdown(pipeline.columns, ticket.checklist));
      setEditingChecklistMd(true);
    }
  }, [ticket, pipeline]);

  const handleChecklistMdChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setChecklistMd(e.target.value);
  }, []);

  const handleSaveChecklistMd = useCallback(() => {
    if (!pipeline) {
      return;
    }
    const parsed = markdownToChecklist(checklistMd, pipeline.columns);
    for (const col of pipeline.columns) {
      const items = parsed[col.id] ?? [];
      void fleetApi.updateChecklist(ticket.id, col.id, items);
    }
    setEditingChecklistMd(false);
  }, [checklistMd, pipeline, ticket.id]);

  const handleCancelChecklistMd = useCallback(() => {
    setEditingChecklistMd(false);
  }, []);

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-fg">Checklists</span>
        <IconButton
          aria-label="Edit as Markdown"
          icon={<PiCodeBold />}
          size="sm"
          onClick={editingChecklistMd ? handleCancelChecklistMd : handleStartEditChecklistMd}
          className={editingChecklistMd ? 'text-accent-500' : ''}
        />
      </div>
      {editingChecklistMd ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={checklistMd}
            onChange={handleChecklistMdChange}
            autoFocus
            rows={16}
            className="w-full rounded-md border border-accent-500 bg-surface px-3 py-2 text-sm text-fg font-mono placeholder:text-fg-muted/50 focus:outline-none resize-y"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSaveChecklistMd}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelChecklistMd}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        checklistColumns.map((col) => (
          <ChecklistColumnSection
            key={col.id}
            columnId={col.id}
            columnLabel={col.label}
            items={ticket.checklist[col.id] ?? []}
            isCurrent={col.id === ticket.columnId}
            newText={newChecklistText[col.id] ?? ''}
            onToggle={handleToggleChecklistItem}
            onRemove={handleRemoveChecklistItem}
            onNewTextChange={handleNewChecklistTextChange}
            onAdd={handleAddChecklistItem}
            onKeyDown={handleChecklistKeyDown}
          />
        ))
      )}
    </div>
  );
});
FleetTicketPlanTab.displayName = 'FleetTicketPlanTab';

// --- Sub-components ---

const ChecklistItemRow = memo(
  ({
    item,
    onToggle,
    onRemove,
  }: {
    item: FleetChecklistItem;
    onToggle: (id: string) => void;
    onRemove: (id: string) => void;
  }) => {
    const handleToggle = useCallback(() => {
      onToggle(item.id);
    }, [item.id, onToggle]);

    const handleRemove = useCallback(() => {
      onRemove(item.id);
    }, [item.id, onRemove]);

    return (
      <div className="flex items-center gap-2 group">
        <button
          onClick={handleToggle}
          className={cn(
            'size-4 rounded border shrink-0 flex items-center justify-center cursor-pointer transition-colors',
            item.completed
              ? 'bg-accent-500 border-accent-500 text-white'
              : 'border-surface-border hover:border-accent-500'
          )}
        >
          {item.completed && <PiCheckCircleBold size={10} />}
        </button>
        <span className={cn('flex-1 text-sm', item.completed ? 'text-fg-muted line-through' : 'text-fg')}>
          {item.text}
        </span>
        <IconButton
          aria-label="Remove item"
          icon={<PiTrashFill />}
          size="sm"
          onClick={handleRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>
    );
  }
);
ChecklistItemRow.displayName = 'ChecklistItemRow';

const ChecklistColumnSection = memo(
  ({
    columnId,
    columnLabel,
    items,
    isCurrent,
    newText,
    onToggle,
    onRemove,
    onNewTextChange,
    onAdd,
    onKeyDown,
  }: {
    columnId: FleetColumnId;
    columnLabel: string;
    items: FleetChecklistItem[];
    isCurrent: boolean;
    newText: string;
    onToggle: (columnId: string, itemId: string) => void;
    onRemove: (columnId: string, itemId: string) => void;
    onNewTextChange: (columnId: string, e: React.ChangeEvent<HTMLInputElement>) => void;
    onAdd: (columnId: string) => void;
    onKeyDown: (columnId: string, e: React.KeyboardEvent) => void;
  }) => {
    const completedCount = items.filter((i) => i.completed).length;

    const handleToggle = useCallback(
      (itemId: string) => {
        onToggle(columnId, itemId);
      },
      [columnId, onToggle]
    );

    const handleRemove = useCallback(
      (itemId: string) => {
        onRemove(columnId, itemId);
      },
      [columnId, onRemove]
    );

    const handleTextChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        onNewTextChange(columnId, e);
      },
      [columnId, onNewTextChange]
    );

    const handleAdd = useCallback(() => {
      onAdd(columnId);
    }, [columnId, onAdd]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        onKeyDown(columnId, e);
      },
      [columnId, onKeyDown]
    );

    return (
      <div
        className={cn(
          'rounded-lg border p-3',
          isCurrent ? 'border-accent-500/50 bg-accent-500/5' : 'border-surface-border bg-surface-overlay/30'
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full font-medium',
              COLUMN_BADGE_COLORS[columnId] ?? 'text-fg-muted bg-fg-muted/10'
            )}
          >
            {columnLabel}
          </span>
          <span className="text-[10px] text-fg-muted">
            {completedCount}/{items.length}
          </span>
          {isCurrent && <span className="text-[10px] text-accent-500 font-medium">Current</span>}
        </div>
        {items.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {items.map((item) => (
              <ChecklistItemRow key={item.id} item={item} onToggle={handleToggle} onRemove={handleRemove} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newText}
            onChange={handleTextChange}
            placeholder="Add checklist item..."
            className="flex-1 rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
            onKeyDown={handleKeyDown}
          />
          <IconButton
            aria-label="Add item"
            icon={<PiPlusBold />}
            size="sm"
            onClick={handleAdd}
            isDisabled={!newText.trim()}
          />
        </div>
      </div>
    );
  }
);
ChecklistColumnSection.displayName = 'ChecklistColumnSection';
