import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { Add20Regular, ArrowDown20Regular, ArrowUp20Regular, Delete20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  IconButton,
  Input,
  Switch,
} from '@/renderer/ds';
import type { Column, ProjectId } from '@/shared/types';

import { $pipeline, ticketApi } from './state';
import { getColumnColors } from './ticket-constants';

const useStyles = makeStyles({
  columnCard: {
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalM,
  },
  columnHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  actionsGroup: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  fieldLabel: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  bodyColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxHeight: '60vh',
    overflowY: 'auto',
  },
  helpText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase200,
    },
  },
  addRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  flex1: {
    flex: '1 1 0',
  },
});

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
    const styles = useStyles();
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
      <div className={styles.columnCard}>
        <div className={styles.columnHeader}>
          {editing ? (
            <Input
              size="sm"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              autoFocus
            />
          ) : (
            <button
              onClick={handleStartRename}
              className="text-xs px-1.5 py-0.5 rounded-full font-medium cursor-pointer hover:ring-1 hover:ring-accent-500/50"
              style={{ color: getColumnColors(column.id).badgeColor, backgroundColor: getColumnColors(column.id).badgeBg }}
              title="Click to rename"
            >
              {column.label}
            </button>
          )}

          <div className={styles.actionsGroup}>
            <IconButton
              aria-label="Move up"
              icon={<ArrowUp20Regular />}
              size="sm"
              onClick={handleMoveUp}
              isDisabled={index === 0}
            />
            <IconButton
              aria-label="Move down"
              icon={<ArrowDown20Regular />}
              size="sm"
              onClick={handleMoveDown}
              isDisabled={index === total - 1}
            />
            {isRemovable && (
              <IconButton
                aria-label="Remove column"
                icon={<Delete20Filled />}
                size="sm"
                onClick={handleRemoveColumn}
              />
            )}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Max concurrent</label>
          <Input
            type="number"
            size="sm"
            value={column.maxConcurrent?.toString() ?? ''}
            onChange={handleMaxConcurrentChange}
            placeholder="&#x221E;"
          />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Gate</label>
          <Switch checked={column.gate ?? false} onCheckedChange={(checked) => onGateChange(column.id, checked)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Description</label>
          <Input
            size="sm"
            value={column.description ?? ''}
            onChange={(e) => onDescriptionChange(column.id, e.target.value)}
            placeholder="What does this column mean?"
            className={styles.flex1}
          />
        </div>
      </div>
    );
  }
);
ColumnEditor.displayName = 'ColumnEditor';

export const PipelineSettingsDialog = memo(
  ({ projectId, open, onClose }: { projectId: ProjectId; open: boolean; onClose: () => void }) => {
    const styles = useStyles();
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
        if (!prev) {
return prev;
}
        return prev.map((col) => (col.id !== columnId ? col : { ...col, gate: checked }));
      });
    }, []);

    const handleDescriptionChange = useCallback((columnId: string, value: string) => {
      setEditColumns((prev) => {
        if (!prev) {
return prev;
}
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
          <DialogBody className={styles.bodyColumn}>
            <p className={styles.helpText}>
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
            <div className={styles.addRow}>
              <Input
                size="sm"
                value={newColumnLabel}
                onChange={(e) => setNewColumnLabel(e.target.value)}
                placeholder="Add column..."
                onKeyDown={handleAddColumnKeyDown}
                className={styles.flex1}
              />
              <IconButton
                aria-label="Add column"
                icon={<Add20Regular />}
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
