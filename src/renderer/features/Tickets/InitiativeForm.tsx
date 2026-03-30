import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds';
import { initiativeApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

export const InitiativeForm = memo(({ projectId, onClose }: { projectId: ProjectId; onClose: () => void }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);

  const project = useMemo(
    () => persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId),
    [projectId]
  );

  useEffect(() => {
    if (!project) return;
    ticketApi.checkGitRepo(project.workspaceDir).then((info) => {
      setGitInfo(info);
    });
  }, [project]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await initiativeApi.addInitiative({
        projectId,
        title: title.trim(),
        description: description.trim(),
        status: 'active',
        ...(gitInfo?.isGitRepo && branch ? { branch } : {}),
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, branch, gitInfo, isSubmitting, projectId, onClose]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Initiative title..."
        className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description — what is this initiative delivering?"
        rows={2}
        className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 resize-none"
      />
      {gitInfo?.isGitRepo && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-fg-subtle">Branch</label>
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
          >
            <option value="">None</option>
            {gitInfo.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit} isDisabled={!title.trim() || isSubmitting}>
          Create Initiative
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
});
InitiativeForm.displayName = 'InitiativeForm';
