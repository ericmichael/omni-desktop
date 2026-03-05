import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiArrowDownBold, PiArrowUpBold, PiPlusBold, PiTrashFill } from 'react-icons/pi';

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

const ColumnEditor = memo(
  ({
    column,
    index,
    total,
    items,
    onRemove,
    onAdd,
    onMaxConcurrentChange,
    onRename,
    onMoveUp,
    onMoveDown,
    onRemoveColumn,
    isRemovable,
  }: {
    column: FleetColumn;
    index: number;
    total: number;
    items: DefaultChecklistItem[];
    onRemove: (columnId: string, itemId: string) => void;
    onAdd: (columnId: string, text: string) => void;
    onMaxConcurrentChange: (columnId: string, value: number | undefined) => void;
    onRename: (columnId: string, label: string) => void;
    onMoveUp: (index: number) => void;
    onMoveDown: (index: number) => void;
    onRemoveColumn: (columnId: string) => void;
    isRemovable: boolean;
  }) => {
    const [newText, setNewText] = useState('');
    const [editing, setEditing] = useState(false);
    const [editLabel, setEditLabel] = useState(column.label);

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

    const handleStartRename = useCallback(() => {
      setEditLabel(column.label);
      setEditing(true);
    }, [column.label]);

    const handleFinishRename = useCallback(() => {
      const trimmed = editLabel.trim();
      if (trimmed && trimmed !== column.label) {
        onRename(column.id, trimmed);
      }
      setEditing(false);
    }, [column.id, column.label, editLabel, onRename]);

    const handleRenameKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          handleFinishRename();
        } else if (e.key === 'Escape') {
          setEditing(false);
        }
      },
      [handleFinishRename]
    );

    const handleMoveUp = useCallback(() => onMoveUp(index), [index, onMoveUp]);
    const handleMoveDown = useCallback(() => onMoveDown(index), [index, onMoveDown]);
    const handleRemoveColumn = useCallback(() => onRemoveColumn(column.id), [column.id, onRemoveColumn]);

    return (
      <div className="rounded-lg border border-surface-border bg-surface-overlay/30 p-3">
        <div className="flex items-center gap-2 mb-2">
          {editing ? (
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              autoFocus
              className="rounded border border-accent-500 bg-surface px-1.5 py-0.5 text-xs font-medium text-fg focus:outline-none"
            />
          ) : (
            <button
              onClick={handleStartRename}
              className={cn(
                'text-xs px-1.5 py-0.5 rounded-full font-medium cursor-pointer hover:ring-1 hover:ring-accent-500/50',
                COLUMN_BADGE_COLORS[column.id] ?? 'text-fg-muted bg-fg-muted/10'
              )}
              title="Click to rename"
            >
              {column.label}
            </button>
          )}
          <span className="text-[10px] text-fg-muted">{items.length} items</span>

          <div className="ml-auto flex items-center gap-1">
            <IconButton
              aria-label="Move up"
              icon={<PiArrowUpBold />}
              size="sm"
              onClick={handleMoveUp}
              isDisabled={index === 0}
              className="opacity-60 hover:opacity-100"
            />
            <IconButton
              aria-label="Move down"
              icon={<PiArrowDownBold />}
              size="sm"
              onClick={handleMoveDown}
              isDisabled={index === total - 1}
              className="opacity-60 hover:opacity-100"
            />
            {isRemovable && (
              <IconButton
                aria-label="Remove column"
                icon={<PiTrashFill />}
                size="sm"
                onClick={handleRemoveColumn}
                className="opacity-60 hover:opacity-100 text-red-400"
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 mb-2">
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
ColumnEditor.displayName = 'ColumnEditor';

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
      return JSON.stringify(editColumns) !== JSON.stringify(pipeline.columns);
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

    const handleRename = useCallback((columnId: string, label: string) => {
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        return prev.map((col) => (col.id === columnId ? { ...col, label } : col));
      });
    }, []);

    const handleMoveUp = useCallback((index: number) => {
      setEditColumns((prev) => {
        if (!prev || index <= 0) {
          return prev;
        }
        const next = [...prev];
        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
        return next;
      });
    }, []);

    const handleMoveDown = useCallback((index: number) => {
      setEditColumns((prev) => {
        if (!prev || index >= prev.length - 1) {
          return prev;
        }
        const next = [...prev];
        [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
        return next;
      });
    }, []);

    const handleRemoveColumn = useCallback((columnId: string) => {
      setEditColumns((prev) => {
        if (!prev || prev.length <= 2) {
          return prev; // Must keep at least 2 columns (first + last)
        }
        return prev.filter((col) => col.id !== columnId);
      });
    }, []);

    const [newColumnLabel, setNewColumnLabel] = useState('');

    const handleAddColumn = useCallback(() => {
      const trimmed = newColumnLabel.trim();
      if (!trimmed) {
        return;
      }
      const id = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!id) {
        return;
      }
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        // Check for duplicate ID
        if (prev.some((col) => col.id === id)) {
          return prev;
        }
        // Insert before the last column (terminal)
        const newCol: FleetColumn = { id, label: trimmed, defaultChecklist: [] };
        const copy = [...prev];
        copy.splice(copy.length - 1, 0, newCol);
        return copy;
      });
      setNewColumnLabel('');
    }, [newColumnLabel]);

    const handleAddColumnKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          handleAddColumn();
        }
      },
      [handleAddColumn]
    );

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
            <p className="text-xs text-fg-muted">
              First column is the backlog. Last column is terminal (completed). Columns in between are active work
              stages.
            </p>
            {editColumns.map((col, i) => (
              <ColumnEditor
                key={col.id}
                column={col}
                index={i}
                total={editColumns.length}
                items={col.defaultChecklist}
                onRemove={handleRemoveItem}
                onAdd={handleAddItem}
                onMaxConcurrentChange={handleMaxConcurrentChange}
                onRename={handleRename}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onRemoveColumn={handleRemoveColumn}
                isRemovable={editColumns.length > 2}
              />
            ))}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="text"
                value={newColumnLabel}
                onChange={(e) => setNewColumnLabel(e.target.value)}
                placeholder="Add column..."
                className="flex-1 rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
                onKeyDown={handleAddColumnKeyDown}
              />
              <IconButton
                aria-label="Add column"
                icon={<PiPlusBold />}
                size="sm"
                onClick={handleAddColumn}
                isDisabled={!newColumnLabel.trim()}
              />
            </div>
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
