import { useStore } from '@nanostores/react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { CATEGORY_LABELS, columnCategory, validatePipelineCategories } from '@/lib/pipeline-category';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Switch } from '@/renderer/ds/ui/switch';
import { Textarea } from '@/renderer/ds/ui/textarea';
import type { Column, ColumnCategory, ProjectId } from '@/shared/types';

import { $pipeline, ticketApi } from './state';
import { getColumnColors } from './ticket-constants';

const CATEGORIES: ColumnCategory[] = ['todo', 'doing', 'done'];

const linesToText = (values: string[] | undefined): string => values?.join('\n') ?? '';
const textToLines = (value: string): string[] | undefined => {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
};
const skillsToText = (values: string[] | undefined): string => values?.join(', ') ?? '';
const textToSkills = (value: string): string[] | undefined => {
  const skills = value
    .split(',')
    .map((skill) => skill.trim())
    .filter(Boolean);
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
    onCategoryChange,
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
    onCategoryChange: (columnId: string, category: ColumnCategory) => void;
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
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onWorkflowChange(column.id, { definitionOfDone: textToLines(e.target.value) }),
      [column.id, onWorkflowChange]
    );
    const handleAgentInstructionsChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onWorkflowChange(column.id, { agentInstructions: e.target.value || undefined }),
      [column.id, onWorkflowChange]
    );
    const handleRecommendedSkillsChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) =>
        onWorkflowChange(column.id, { recommendedSkills: textToSkills(e.target.value) }),
      [column.id, onWorkflowChange]
    );
    const handleCategoryChange = useCallback(
      (e: React.ChangeEvent<HTMLSelectElement>) => onCategoryChange(column.id, e.target.value as ColumnCategory),
      [column.id, onCategoryChange]
    );

    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-2">
          {editing ? (
            <Input
              value={editLabel}
              onChange={handleLabelChange}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              autoFocus
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleStartRename}
              className={cn(
                'cursor-pointer rounded-full px-1.5 py-0.5 text-xs font-medium hover:ring-1 hover:ring-primary/50',
                getColumnColors(column.id).badgeClassName
              )}
              title="Click to rename"
            >
              {column.label}
            </Button>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Move up"
              onClick={handleMoveUp}
              disabled={index === 0}
            >
              <ArrowUp />
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Move down"
              onClick={handleMoveDown}
              disabled={index === total - 1}
            >
              <ArrowDown />
            </Button>

            {isRemovable && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove column"
                onClick={handleRemoveColumn}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-sm text-muted-foreground sm:text-xs">Category</label>
          <Select
            aria-label={`Status category for ${column.label}`}
            value={columnCategory(column, index, total)}
            onChange={handleCategoryChange}
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-muted-foreground sm:text-xs">Max concurrent</label>
          <Input
            type="number"
            value={column.maxConcurrent?.toString() ?? ''}
            onChange={handleMaxConcurrentChange}
            placeholder="&#x221E;"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-muted-foreground sm:text-xs">Gate</label>
          <Switch checked={column.gate ?? false} onCheckedChange={handleGateCheckedChange} />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-muted-foreground sm:text-xs">Description</label>
          <Input
            value={column.description ?? ''}
            onChange={handleDescriptionInputChange}
            placeholder="What does this column mean?"
            className="flex-1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-muted-foreground sm:text-xs">Purpose</label>
          <Input
            value={column.workflow?.purpose ?? ''}
            onChange={handlePurposeChange}
            placeholder="What should happen in this column?"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-muted-foreground sm:text-xs">Definition of done</label>
          <Textarea
            aria-label={`Definition of done for ${column.label}`}
            value={linesToText(column.workflow?.definitionOfDone)}
            onChange={handleDefinitionOfDoneChange}
            placeholder="One checklist item per line"
            rows={4}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-muted-foreground sm:text-xs">Agent instructions</label>
          <Textarea
            aria-label={`Agent instructions for ${column.label}`}
            value={column.workflow?.agentInstructions ?? ''}
            onChange={handleAgentInstructionsChange}
            placeholder="Column-specific instructions for agents"
            rows={3}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-muted-foreground sm:text-xs">Recommended skills</label>
          <Input
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

/**
 * Inline pipeline (column) editor for the project Settings tab. Edits a local
 * draft — column changes are structural (running agents key off column ids),
 * so nothing is written until the user explicitly saves.
 */
export const PipelineEditor = memo(({ projectId }: { projectId: ProjectId }) => {
  const pipeline = useStore($pipeline);

  const [editColumns, setEditColumns] = useState<Column[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the draft whenever the saved pipeline changes identity.
  const columns = useMemo(() => (pipeline ? structuredClone(pipeline.columns) : null), [pipeline]);
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
    setEditColumns(
      (prev) => prev?.map((col) => (col.id !== columnId ? col : { ...col, maxConcurrent: value })) ?? prev
    );
  }, []);

  const handleGateChange = useCallback((columnId: string, checked: boolean) => {
    setEditColumns((prev) => prev?.map((col) => (col.id !== columnId ? col : { ...col, gate: checked })) ?? prev);
  }, []);

  const handleDescriptionChange = useCallback((columnId: string, value: string) => {
    setEditColumns(
      (prev) => prev?.map((col) => (col.id !== columnId ? col : { ...col, description: value || undefined })) ?? prev
    );
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
    setEditColumns((prev) => prev?.map((col) => (col.id === columnId ? { ...col, label } : col)) ?? prev);
  }, []);

  const handleCategoryChange = useCallback((columnId: string, category: ColumnCategory) => {
    setEditColumns((prev) => prev?.map((col) => (col.id === columnId ? { ...col, category } : col)) ?? prev);
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
    const id = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    if (!id) {
      return;
    }
    setEditColumns((prev) => {
      if (!prev || prev.some((col) => col.id === id)) {
        return prev;
      }
      // Insert before the last column (terminal)
      const newCol: Column = { id, label: trimmed, category: 'doing' };
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

  const handleDiscard = useCallback(() => {
    setEditColumns(pipeline ? structuredClone(pipeline.columns) : null);
  }, [pipeline]);

  const handleSave = useCallback(async () => {
    if (!editColumns) {
      return;
    }
    setSaving(true);
    try {
      await ticketApi.updateProject(projectId, { pipeline: { columns: editColumns } });
      await ticketApi.getPipeline(projectId);
    } finally {
      setSaving(false);
    }
  }, [editColumns, projectId]);

  if (!editColumns) {
    return null;
  }

  const categoryError = (() => {
    const validity = validatePipelineCategories(editColumns);
    return validity.isErr() ? validity.error : null;
  })();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground sm:text-xs">
        Columns are the stages agents move work through. Each column&apos;s category (To do / Doing / Done) is how tasks
        group in global views — the last column must be the Done one.
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
          onCategoryChange={handleCategoryChange}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onRemoveColumn={handleRemoveColumn}
          isRemovable={editColumns.length > 2}
        />
      ))}
      <div className="flex items-center gap-2 mt-1">
        <Input
          value={newColumnLabel}
          onChange={handleNewColumnLabelChange}
          placeholder="Add column..."
          onKeyDown={handleAddColumnKeyDown}
          className="flex-1"
        />

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add column"
          onClick={handleAddColumn}
          disabled={!newColumnLabel.trim()}
        >
          <Plus />
        </Button>
      </div>
      {isDirty && categoryError && (
        <div role="alert" className="text-xs text-destructive">
          {categoryError}
        </div>
      )}
      {isDirty && (
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={handleSave} disabled={saving || categoryError !== null}>
            {saving ? 'Saving…' : 'Save pipeline'}
          </Button>
          <Button variant="ghost" onClick={handleDiscard} disabled={saving}>
            Discard
          </Button>
          <span className="text-xs text-warning">Unsaved pipeline changes</span>
        </div>
      )}
    </div>
  );
});
PipelineEditor.displayName = 'PipelineEditor';
