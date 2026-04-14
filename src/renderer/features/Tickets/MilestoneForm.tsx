import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Input, Select, Textarea } from '@/renderer/ds';
import { milestoneApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, Milestone, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalL,
  },
  branchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  branchLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
});

export const MilestoneForm = memo(({
  projectId,
  onClose,
  editMilestone,
}: {
  projectId: ProjectId;
  onClose: () => void;
  editMilestone?: Milestone;
}) => {
  const styles = useStyles();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);

  const project = useMemo(
    () => persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId),
    [projectId]
  );

  useEffect(() => {
    if (!project) {
return;
}
    if (project.source?.kind !== 'local') {
return;
}
    ticketApi.checkGitRepo(project.source.workspaceDir).then((info) => {
      setGitInfo(info);
    });
  }, [project]);

  useEffect(() => {
    setTitle(editMilestone?.title ?? '');
    setDescription(editMilestone?.description ?? '');
    setBranch(editMilestone?.branch ?? '');
    setDueDate(editMilestone?.dueDate ? toInputDate(editMilestone.dueDate) : '');
  }, [editMilestone]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || isSubmitting) {
return;
}
    setIsSubmitting(true);
    try {
      const dueDateMs = fromInputDate(dueDate);
      if (editMilestone) {
        await milestoneApi.updateMilestone(editMilestone.id, {
          title: title.trim(),
          description: description.trim(),
          branch: gitInfo?.isGitRepo ? (branch || undefined) : undefined,
          dueDate: dueDateMs,
        });
      } else {
        await milestoneApi.addMilestone({
          projectId,
          title: title.trim(),
          description: description.trim(),
          status: 'active',
          ...(gitInfo?.isGitRepo && branch ? { branch } : {}),
          ...(dueDateMs !== undefined ? { dueDate: dueDateMs } : {}),
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, branch, dueDate, gitInfo, isSubmitting, projectId, onClose, editMilestone]);

  return (
    <div className={styles.root}>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Milestone title..."
        className="w-full"
        autoFocus
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description — what is this milestone delivering?"
        rows={2}
      />
      {gitInfo?.isGitRepo && (
        <div className={styles.branchRow}>
          <label className={styles.branchLabel}>Branch</label>
          <Select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            size="sm"
          >
            <option value="">None</option>
            {gitInfo.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className={styles.branchRow}>
        <label className={styles.branchLabel}>Due date</label>
        <Input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </div>
      <div className={styles.actions}>
        <Button onClick={handleSubmit} isDisabled={!title.trim() || isSubmitting}>
          {editMilestone ? 'Save Milestone' : 'Create Milestone'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
});
MilestoneForm.displayName = 'MilestoneForm';

/** Format an epoch-ms timestamp as a local YYYY-MM-DD string for <input type="date">. */
function toInputDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD input value into an epoch-ms at local midnight, or undefined. */
function fromInputDate(value: string): number | undefined {
  if (!value) {
return undefined;
}
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) {
return undefined;
}
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
