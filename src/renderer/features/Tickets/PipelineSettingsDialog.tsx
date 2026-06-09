import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
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
  Textarea,
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
  fieldColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
});

const linesToText = (values: string[] | undefined): string => values?.join('\n') ?? '';
const textToLines = (value: string): string[] | undefined => {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};
const skillsToText = (values: string[] | undefined): string => values?.join(', ') ?? '';
const textToSkills = (value: string): string[] | undefined => {
  const skills = value.split(',').map((skill) => skill.trim()).filter(Boolean);
  return skills.length > 0 ? skills : undefined;
};

const ColumnEditor = memo(
  ({
    column,
    index,
    total,
    onMaxConcurrentChange,
    onGateChange,
    onDescriptionChange,
    onWorkflowChange,
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
    onWorkflowChange: (columnId: string, patch: NonNullable<Column['workflow']>) => void;
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
    const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setEditLabel(e.target.value), []);
    const handleGateCheckedChange = useCallback(
      (checked: boolean) => onGateChange(column.id, checked),
      [column.id, onGateChange]
    );
    const handleDescriptionInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => onDescriptionChange(column.id, e.target.value),
      [column.id, onDescriptionChange]
    );
    const handlePurposeChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => onWorkflowChange(column.id, { purpose: e.target.value || undefined }),
      [column.id, onWorkflowChange]
    );
    const handleDefinitionOfDoneChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => onWorkflowChange(column.id, { definitionOfDone: textToLines(e.target.value) }),
      [column.id, onWorkflowChange]
    );
    const handleAgentInstructionsChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onWorkflowChange(column.id, { agentInstructions: e.target.value || undefined }),
      [column.id, onWorkflowChange]
    );
    const handleRecommendedSkillsChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => onWorkflowChange(column.id, { recommendedSkills: textToSkills(e.target.value) }),
      [column.id, onWorkflowChange]
    );

    return (
      <div className={styles.columnCard}>
        <div className={styles.columnHeader}>
          {editing ? (
            <Input
              size="sm"
              value={editLabel}
              onChange={handleLabelChange}
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
          <Switch checked={column.gate ?? false} onCheckedChange={handleGateCheckedChange} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Description</label>
          <Input
            size="sm"
            value={column.description ?? ''}
            onChange={handleDescriptionInputChange}
            placeholder="What does this column mean?"
            className={styles.flex1}
          />
        </div>
        <div className={styles.fieldColumn}>
          <label className={styles.fieldLabel}>Purpose</label>
          <Input
            size="sm"
            value={column.workflow?.purpose ?? ''}
            onChange={handlePurposeChange}
            placeholder="What should happen in this column?"
          />
        </div>
        <div className={styles.fieldColumn}>
          <label className={styles.fieldLabel}>Definition of done</label>
          <Textarea
            aria-label={`Definition of done for ${column.label}`}
            value={linesToText(column.workflow?.definitionOfDone)}
            onChange={handleDefinitionOfDoneChange}
            placeholder="One checklist item per line"
            rows={4}
          />
        </div>
        <div className={styles.fieldColumn}>
          <label className={styles.fieldLabel}>Agent instructions</label>
          <Textarea
            aria-label={`Agent instructions for ${column.label}`}
            value={column.workflow?.agentInstructions ?? ''}
            onChange={handleAgentInstructionsChange}
            placeholder="Column-specific instructions for agents"
            rows={3}
          />
        </div>
        <div className={styles.fieldColumn}>
          <label className={styles.fieldLabel}>Recommended skills</label>
          <Input
            size="sm"
            value={skillsToText(column.workflow?.recommendedSkills)}
            onChange={handleRecommendedSkillsChange}
            placeholder="software-planning, debug"
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

    const handleWorkflowChange = useCallback((columnId: string, patch: NonNullable<Column['workflow']>) => {
      setEditColumns((prev) => {
        if (!prev) {
          return prev;
        }
        return prev.map((col) => {
          if (col.id !== columnId) {
            return col;
          }
          const workflow = { ...(col.workflow ?? {}), ...patch };
          for (const key of Object.keys(workflow) as (keyof typeof workflow)[]) {
            const value = workflow[key];
            if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
              delete workflow[key];
            }
          }
          return { ...col, workflow: Object.keys(workflow).length > 0 ? workflow : undefined };
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
    const handleNewColumnLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setNewColumnLabel(e.target.value);
    }, []);

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
                onWorkflowChange={handleWorkflowChange}
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
                onChange={handleNewColumnLabelChange}
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
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} isDisabled={!isDirty}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
PipelineSettingsDialog.displayName = 'PipelineSettingsDialog';
