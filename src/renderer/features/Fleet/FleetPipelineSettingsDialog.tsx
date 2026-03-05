import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPlusBold, PiTrashFill } from 'react-icons/pi';

import {
  AnimatedDialog,
  Button,
  cn,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  IconButton,
} from '@/renderer/ds';
import type { FleetColumn, FleetProjectId } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './fleet-constants';
import { $fleetPipeline, fleetApi } from './state';

type DefaultChecklistItem = { id: string; text: string };

const DefaultChecklistRow = memo(
  ({ item, onRemove }: { item: DefaultChecklistItem; onRemove: (id: string) => void }) => {
    const handleRemove = useCallback(() => {
      onRemove(item.id);
    }, [item.id, onRemove]);

    return (
      <div className="flex items-center gap-2 group">
        <span className="flex-1 text-sm text-fg">{item.text}</span>
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
DefaultChecklistRow.displayName = 'DefaultChecklistRow';

const ColumnChecklistEditor = memo(
  ({
    column,
    items,
    onRemove,
    onAdd,
    onMaxConcurrentChange,
  }: {
    column: FleetColumn;
    items: DefaultChecklistItem[];
    onRemove: (columnId: string, itemId: string) => void;
    onAdd: (columnId: string, text: string) => void;
    onMaxConcurrentChange: (columnId: string, value: number | undefined) => void;
  }) => {
    const [newText, setNewText] = useState('');

    const handleTextChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setNewText(e.target.value);
    }, []);

    const handleAdd = useCallback(() => {
      const trimmed = newText.trim();
      if (!trimmed) {
        return;
      }
      onAdd(column.id, trimmed);
      setNewText('');
    }, [column.id, newText, onAdd]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          handleAdd();
        }
      },
      [handleAdd]
    );

    const handleRemoveItem = useCallback(
      (itemId: string) => {
        onRemove(column.id, itemId);
      },
      [column.id, onRemove]
    );

    const handleMaxConcurrentChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.trim();
        onMaxConcurrentChange(column.id, raw === '' ? undefined : Math.max(1, parseInt(raw, 10) || 1));
      },
      [column.id, onMaxConcurrentChange]
    );

    return (
      <div className="rounded-lg border border-surface-border bg-surface-overlay/30 p-3">
        <div className="flex items-center gap-2 mb-2">
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full font-medium',
              COLUMN_BADGE_COLORS[column.id] ?? 'text-fg-muted bg-fg-muted/10'
            )}
          >
            {column.label}
          </span>
          <span className="text-[10px] text-fg-muted">{items.length} items</span>
          <div className="ml-auto flex items-center gap-1.5">
            <label className="text-[10px] text-fg-muted">Max concurrent</label>
            <input
              type="number"
              min={1}
              value={column.maxConcurrent ?? ''}
              onChange={handleMaxConcurrentChange}
              placeholder="∞"
              className="w-12 rounded border border-surface-border bg-surface px-1.5 py-0.5 text-xs text-fg text-center placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
            />
          </div>
        </div>
        {items.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {items.map((item) => (
              <DefaultChecklistRow key={item.id} item={item} onRemove={handleRemoveItem} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newText}
            onChange={handleTextChange}
            placeholder="Add default checklist item..."
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
ColumnChecklistEditor.displayName = 'ColumnChecklistEditor';

export const FleetPipelineSettingsDialog = memo(
  ({ projectId, open, onClose }: { projectId: FleetProjectId; open: boolean; onClose: () => void }) => {
    const pipeline = useStore($fleetPipeline);

    // Deep-clone columns for local editing
    const [editColumns, setEditColumns] = useState<FleetColumn[] | null>(null);

    // Reset local state when dialog opens
    const columns = useMemo(() => {
      if (!open || !pipeline) {
        return null;
      }
      return structuredClone(pipeline.columns);
    }, [open, pipeline]);

    // Sync reset: when columns ref changes (dialog open/pipeline change), reset edit state
    const [prevColumns, setPrevColumns] = useState(columns);
    if (columns !== prevColumns) {
      setPrevColumns(columns);
      setEditColumns(columns);
    }

    const isDirty = useMemo(() => {
      if (!editColumns || !pipeline) {
        return false;
      }
      return (
        JSON.stringify(editColumns.map((c) => ({ cl: c.defaultChecklist, mc: c.maxConcurrent }))) !==
        JSON.stringify(pipeline.columns.map((c) => ({ cl: c.defaultChecklist, mc: c.maxConcurrent })))
      );
    }, [editColumns, pipeline]);

    const handleRemoveItem = useCallback((columnId: string, itemId: string) => {
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        return prev.map((col) => {
          if (col.id !== columnId) {
            return col;
          }
          return { ...col, defaultChecklist: col.defaultChecklist.filter((item) => item.id !== itemId) };
        });
      });
    }, []);

    const handleAddItem = useCallback((columnId: string, text: string) => {
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        return prev.map((col) => {
          if (col.id !== columnId) {
            return col;
          }
          const newItem = { id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, completed: false };
          return { ...col, defaultChecklist: [...col.defaultChecklist, newItem] };
        });
      });
    }, []);

    const handleMaxConcurrentChange = useCallback((columnId: string, value: number | undefined) => {
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        return prev.map((col) => {
          if (col.id !== columnId) {
            return col;
          }
          return { ...col, maxConcurrent: value };
        });
      });
    }, []);

    const handleSave = useCallback(async () => {
      if (!editColumns) {
        return;
      }
      await fleetApi.updateProject(projectId, { pipeline: { columns: editColumns } });
      await fleetApi.getPipeline(projectId);
      onClose();
    }, [editColumns, projectId, onClose]);

    if (!editColumns) {
      return null;
    }

    return (
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>Pipeline Settings</DialogHeader>
          <DialogBody className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            {editColumns.map((col) => (
              <ColumnChecklistEditor
                key={col.id}
                column={col}
                items={col.defaultChecklist}
                onRemove={handleRemoveItem}
                onAdd={handleAddItem}
                onMaxConcurrentChange={handleMaxConcurrentChange}
              />
            ))}
          </DialogBody>
          <DialogFooter className="gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} isDisabled={!isDirty}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
FleetPipelineSettingsDialog.displayName = 'FleetPipelineSettingsDialog';
