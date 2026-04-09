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
  Input,
  Switch,
} from '@/renderer/ds';
import type { Column, ProjectId } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './ticket-constants';
import { $pipeline, ticketApi } from './state';

const ColumnEditor = memo(
  ({
    column,
    index,
    total,
    onMaxConcurrentChange,
    onGateChange,
    onDescriptionChange,
    onRename,
    onMoveUp,
    onMoveDown,
    onRemoveColumn,
    isRemovable,
  }: {
    column: Column;
    index: number;
    total: number;
    onMaxConcurrentChange: (columnId: string, value: number | undefined) => void;
    onGateChange: (columnId: string, checked: boolean) => void;
    onDescriptionChange: (columnId: string, value: string) => void;
    onRename: (columnId: string, label: string) => void;
    onMoveUp: (index: number) => void;
    onMoveDown: (index: number) => void;
    onRemoveColumn: (columnId: string) => void;
    isRemovable: boolean;
  }) => {
    const [editing, setEditing] = useState(false);
    const [editLabel, setEditLabel] = useState(column.label);

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
              className="rounded-lg border border-accent-500 bg-surface px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-sm sm:text-xs font-medium text-fg focus:outline-none"
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

        <div className="flex items-center gap-1.5">
          <label className="text-sm sm:text-xs text-fg-muted">Max concurrent</label>
          <input
            type="number"
            min={1}
            value={column.maxConcurrent ?? ''}
            onChange={handleMaxConcurrentChange}
            placeholder="∞"
            className="w-14 sm:w-12 rounded-lg border border-surface-border bg-surface px-2 py-1.5 sm:px-1.5 sm:py-0.5 text-sm sm:text-xs text-fg text-center placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm sm:text-xs text-fg-muted">Gate</label>
          <Switch checked={column.gate ?? false} onCheckedChange={(checked) => onGateChange(column.id, checked)} />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm sm:text-xs text-fg-muted">Description</label>
          <Input
            size="sm"
            value={column.description ?? ''}
            onChange={(e) => onDescriptionChange(column.id, e.target.value)}
            placeholder="What does this column mean?"
            className="flex-1"
          />
        </div>
      </div>
    );
  }
);
ColumnEditor.displayName = 'ColumnEditor';

export const PipelineSettingsDialog = memo(
  ({ projectId, open, onClose }: { projectId: ProjectId; open: boolean; onClose: () => void }) => {
    const pipeline = useStore($pipeline);

    // Deep-clone columns for local editing
    const [editColumns, setEditColumns] = useState<Column[] | null>(null);

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

    const handleGateChange = useCallback((columnId: string, checked: boolean) => {
      setEditColumns((prev) => {
        if (!prev) return prev;
        return prev.map((col) => (col.id !== columnId ? col : { ...col, gate: checked }));
      });
    }, []);

    const handleDescriptionChange = useCallback((columnId: string, value: string) => {
      setEditColumns((prev) => {
        if (!prev) return prev;
        return prev.map((col) => (col.id !== columnId ? col : { ...col, description: value || undefined }));
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
        const newCol: Column = { id, label: trimmed };
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
      await ticketApi.updateProject(projectId, { pipeline: { columns: editColumns } });
      await ticketApi.getPipeline(projectId);
      onClose();
    }, [editColumns, projectId, onClose]);

    if (!editColumns) {
      return null;
    }

    return (
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>Pipeline Settings</DialogHeader>
          <DialogBody className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            <p className="text-sm sm:text-xs text-fg-muted">
              First column is the backlog. Last column is terminal (completed). Columns in between are active work
              stages.
            </p>
            {editColumns.map((col, i) => (
              <ColumnEditor
                key={col.id}
                column={col}
                index={i}
                total={editColumns.length}
                onMaxConcurrentChange={handleMaxConcurrentChange}
                onGateChange={handleGateChange}
                onDescriptionChange={handleDescriptionChange}
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
                className="flex-1 rounded-lg border border-surface-border bg-surface px-3 py-2 sm:px-2 sm:py-1.5 text-base sm:text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
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
          <DialogFooter className="gap-2 justify-end flex-col sm:flex-row">
            <Button variant="ghost" onClick={onClose} className="justify-center h-12 text-base sm:h-9 sm:text-sm order-2 sm:order-1">
              Cancel
            </Button>
            <Button onClick={handleSave} isDisabled={!isDirty} className="justify-center h-12 text-base sm:h-9 sm:text-sm order-1 sm:order-2">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
PipelineSettingsDialog.displayName = 'PipelineSettingsDialog';
