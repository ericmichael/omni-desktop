import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Switch } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetProjectId, FleetTicketPriority, GitRepoInfo } from '@/shared/types';

import { $fleetTickets, fleetApi } from './state';

export const FleetTicketForm = memo(({ projectId, onClose }: { projectId: FleetProjectId; onClose: () => void }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<FleetTicketPriority>('medium');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [branch, setBranch] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);

  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.fleetProjects.find((p) => p.id === projectId), [store.fleetProjects, projectId]);

  const tickets = useStore($fleetTickets);
  const projectTickets = useMemo(
    () => Object.values(tickets).filter((t) => t.projectId === projectId),
    [tickets, projectId]
  );

  useEffect(() => {
    if (!project) return;
    fleetApi.checkGitRepo(project.workspaceDir).then((info) => {
      setGitInfo(info);
      if (info.isGitRepo) {
        setBranch(info.currentBranch);
      }
    });
  }, [project]);

  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  }, []);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
  }, []);

  const handlePriorityChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setPriority(e.target.value as FleetTicketPriority);
  }, []);

  const handleBlockedByChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const selected = Array.from(e.target.selectedOptions, (opt) => opt.value);
    setBlockedBy(selected);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await fleetApi.addTicket({
        projectId,
        title: title.trim(),
        description: description.trim(),
        priority,
        blockedBy,
        ...(gitInfo?.isGitRepo && { branch, useWorktree }),
      });
      setTitle('');
      setDescription('');
      setPriority('medium');
      setBlockedBy([]);
      setUseWorktree(false);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, priority, blockedBy, branch, useWorktree, gitInfo, isSubmitting, projectId, onClose]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-4">
      <input
        value={title}
        onChange={handleTitleChange}
        placeholder="Ticket title..."
        className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
      />
      <textarea
        value={description}
        onChange={handleDescriptionChange}
        placeholder="Description (optional)..."
        rows={2}
        className="w-full rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 resize-none"
      />
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-fg-subtle">Priority</label>
          <select
            value={priority}
            onChange={handlePriorityChange}
            className="rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        {projectTickets.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-fg-subtle">Blocked by</label>
            <select
              multiple
              value={blockedBy}
              onChange={handleBlockedByChange}
              className="rounded-md border border-surface-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-accent-500 max-h-20"
            >
              {projectTickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {gitInfo?.isGitRepo && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-fg-subtle">Branch</label>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
            >
              {gitInfo.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-fg-subtle">Worktree</label>
            <Switch checked={useWorktree} onCheckedChange={setUseWorktree} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit} isDisabled={!title.trim() || isSubmitting}>
          Create Ticket
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
});
FleetTicketForm.displayName = 'FleetTicketForm';
