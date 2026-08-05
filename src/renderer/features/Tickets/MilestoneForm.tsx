import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { milestoneApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, Milestone, ProjectId } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { ticketApi } from './state';

export const MilestoneForm = memo(
  ({ projectId, onClose, editMilestone }: { projectId: ProjectId; onClose: () => void; editMilestone?: Milestone }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [branch, setBranch] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);

    const project = useMemo(() => persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId), [projectId]);

    useEffect(() => {
      if (!project) {
        return;
      }
      if (firstSource(project)?.kind !== 'local') {
        return;
      }
      const s = firstSource(project);
      if (s?.kind !== 'local') {
        return;
      }
      ticketApi.checkGitRepo(s.workspaceDir).then((info) => {
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
            branch: gitInfo?.isGitRepo ? branch || undefined : undefined,
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
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
        <Input
          aria-label="Milestone title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Milestone title..."
          className="w-full"
          autoFocus
        />

        <Textarea
          aria-label="Milestone description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description — what is this milestone delivering?"
          rows={2}
        />

        {gitInfo?.isGitRepo && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-muted-foreground">Branch</label>
            <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">None</option>
              {gitInfo.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">Due date</label>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleSubmit} disabled={!title.trim() || isSubmitting}>
            {editMilestone ? 'Save Milestone' : 'Create Milestone'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
);
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
