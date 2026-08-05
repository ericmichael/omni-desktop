import { useStore } from '@nanostores/react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/renderer/ds/ui/command';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/ds/ui/popover';
import { Switch } from '@/renderer/ds/ui/switch';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, MilestoneId, ProjectId, TicketPriority } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { $activeMilestoneId, $tickets, ticketApi } from './state';

export const TicketForm = memo(({ projectId, onClose }: { projectId: ProjectId; onClose: () => void }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [branch, setBranch] = useState('');
  const [useWorktree, setUseWorktree] = useState(false);

  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const projectHasRepo = firstSource(project) != null;

  const milestones = useStore($milestones);
  const activeMilestoneId = useStore($activeMilestoneId);
  const projectMilestones = useMemo(
    () => Object.values(milestones).filter((i) => i.projectId === projectId),
    [milestones, projectId]
  );
  const defaultMilestoneId = useMemo(
    () => (activeMilestoneId !== 'all' ? activeMilestoneId : (projectMilestones[0]?.id ?? '')),
    [activeMilestoneId, projectMilestones]
  );
  const [milestoneId, setMilestoneId] = useState<MilestoneId>(defaultMilestoneId);

  const tickets = useStore($tickets);
  const projectTickets = useMemo(
    () => Object.values(tickets).filter((t) => t.projectId === projectId),
    [tickets, projectId]
  );

  // Only fetch git info when project has a local repo
  useEffect(() => {
    if (!project) {
      return;
    }
    const projectSource = firstSource(project);
    if (projectSource?.kind !== 'local') {
      return;
    }
    ticketApi.checkGitRepo(projectSource.workspaceDir).then((info) => {
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
    setPriority(e.target.value as TicketPriority);
  }, []);

  const handleToggleBlocker = useCallback((ticketId: string) => {
    setBlockedBy((current) =>
      current.includes(ticketId) ? current.filter((id) => id !== ticketId) : [...current, ticketId]
    );
  }, []);

  const blockedByLabel = useMemo(() => {
    if (blockedBy.length === 0) {
      return 'None';
    }
    if (blockedBy.length === 1) {
      return projectTickets.find((ticket) => ticket.id === blockedBy[0])?.title ?? '1 task';
    }
    return `${blockedBy.length} tasks`;
  }, [blockedBy, projectTickets]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await ticketApi.addTicket({
        projectId,
        milestoneId: milestoneId || undefined,
        title: title.trim(),
        description: description.trim(),
        priority,
        blockedBy,
        ...(gitInfo?.isGitRepo && { useWorktree, ...(useWorktree && { branch }) }),
      });
      setTitle('');
      setDescription('');
      setPriority('medium');
      setBlockedBy([]);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [
    title,
    description,
    priority,
    blockedBy,
    branch,
    useWorktree,
    gitInfo,
    isSubmitting,
    projectId,
    milestoneId,
    onClose,
  ]);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <Input
        aria-label="Task title"
        value={title}
        onChange={handleTitleChange}
        placeholder="Task title..."
        className="w-full"
      />

      <Textarea
        aria-label="Task description"
        value={description}
        onChange={handleDescriptionChange}
        placeholder="Description (optional)..."
        rows={2}
      />

      <div className="flex items-center gap-4 flex-wrap">
        {projectMilestones.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-muted-foreground">Milestone</label>
            <Select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              {projectMilestones.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">Priority</label>
          <Select value={priority} onChange={handlePriorityChange}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </Select>
        </div>
        {projectTickets.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-muted-foreground">Blocked by</label>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="w-48 justify-between font-normal">
                  <span className="truncate">{blockedByLabel}</span>
                  <ChevronsUpDown className="opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search tasks…" />
                  <CommandList>
                    <CommandEmpty>No tasks found.</CommandEmpty>
                    <CommandGroup>
                      {projectTickets.map((ticket) => {
                        const selected = blockedBy.includes(ticket.id);
                        return (
                          <CommandItem
                            key={ticket.id}
                            value={`${ticket.title} ${ticket.id}`}
                            onSelect={() => handleToggleBlocker(ticket.id)}
                          >
                            <Check className={selected ? 'opacity-100' : 'opacity-0'} />
                            <span className="truncate">{ticket.title}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
      {projectHasRepo && gitInfo?.isGitRepo && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-muted-foreground">Isolated worktree</label>
            <Switch checked={useWorktree} onCheckedChange={setUseWorktree} />
          </div>
          {useWorktree && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">Branch</label>
              <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
                {gitInfo.branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={handleSubmit} disabled={!title.trim() || isSubmitting}>
          Create Ticket
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
});
TicketForm.displayName = 'TicketForm';
