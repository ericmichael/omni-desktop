import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiTrashFill } from 'react-icons/pi';

import { Button, Heading, IconButton, Switch } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetProjectId, FleetTicket, GitRepoInfo } from '@/shared/types';

import { FleetTaskCard } from './FleetTaskCard';
import { FleetTicketCard } from './FleetTicketCard';
import { FleetTicketForm } from './FleetTicketForm';
import { $fleetTasks, $fleetTickets, fleetApi } from './state';

export const FleetProjectDetail = memo(({ projectId }: { projectId: FleetProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const tasks = useStore($fleetTasks);
  const tickets = useStore($fleetTickets);
  const [taskDescription, setTaskDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [ticketFormOpen, setTicketFormOpen] = useState(false);

  const project = useMemo(() => store.fleetProjects.find((p) => p.id === projectId), [store.fleetProjects, projectId]);

  const projectTasks = useMemo(() => Object.values(tasks).filter((t) => t.projectId === projectId), [tasks, projectId]);

  const projectTickets = useMemo(
    () =>
      Object.values(tickets)
        .filter((t) => t.projectId === projectId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [tickets, projectId]
  );

  const isTicketBlocked = useCallback(
    (ticket: FleetTicket): boolean => {
      return ticket.blockedBy.some((blockerId) => {
        const blocker = tickets[blockerId];
        return blocker && blocker.status !== 'completed' && blocker.status !== 'closed';
      });
    },
    [tickets]
  );

  useEffect(() => {
    if (!project) {
      return;
    }
    let cancelled = false;
    fleetApi.checkGitRepo(project.workspaceDir).then((info) => {
      if (cancelled) {
        return;
      }
      setGitInfo(info);
      if (info.isGitRepo) {
        setSelectedBranch(info.currentBranch);
        setUseWorktree(true);
      }
    });
    fleetApi.fetchTickets(projectId);
    return () => {
      cancelled = true;
    };
  }, [project, projectId]);

  const handleTaskDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setTaskDescription(e.target.value);
  }, []);

  const handleBranchChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedBranch(e.target.value);
  }, []);

  const handleWorktreeToggle = useCallback((checked: boolean) => {
    setUseWorktree(checked);
  }, []);

  const handleSubmitTask = useCallback(async () => {
    if (!taskDescription.trim() || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await fleetApi.submitTask(projectId, taskDescription.trim(), {
        branch: selectedBranch || undefined,
        useWorktree,
      });
      setTaskDescription('');
    } finally {
      setIsSubmitting(false);
    }
  }, [taskDescription, isSubmitting, projectId, selectedBranch, useWorktree]);

  const handleOpenTicketForm = useCallback(() => {
    setTicketFormOpen(true);
  }, []);

  const handleCloseTicketForm = useCallback(() => {
    setTicketFormOpen(false);
  }, []);

  const handleNextTicket = useCallback(async () => {
    const next = await fleetApi.getNextTicket(projectId);
    if (next) {
      fleetApi.goToTicket(next.id);
    }
  }, [projectId]);

  const handleRemoveProject = useCallback(async () => {
    await fleetApi.removeProject(projectId);
    fleetApi.goToDashboard();
  }, [projectId]);

  if (!project) {
    return null;
  }

  const isGitRepo = gitInfo?.isGitRepo === true;

  return (
    <div className="flex flex-col w-full h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-surface-border shrink-0">
        <div className="flex-1 min-w-0">
          <Heading size="md">{project.label}</Heading>
          <span className="text-xs text-fg-subtle truncate block">{project.workspaceDir}</span>
        </div>
        <IconButton aria-label="Delete project" icon={<PiTrashFill />} size="sm" onClick={handleRemoveProject} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="flex flex-col gap-6 max-w-2xl">
          {/* Tickets section */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-fg">Tickets ({projectTickets.length})</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={handleNextTicket}>
                  Next Ticket
                </Button>
                {!ticketFormOpen && (
                  <Button size="sm" onClick={handleOpenTicketForm}>
                    New Ticket
                  </Button>
                )}
              </div>
            </div>
            {ticketFormOpen && <FleetTicketForm projectId={projectId} onClose={handleCloseTicketForm} />}
            {projectTickets.length > 0 && (
              <div className="flex flex-col gap-2">
                {projectTickets.map((ticket) => (
                  <FleetTicketCard key={ticket.id} ticket={ticket} isBlocked={isTicketBlocked(ticket)} />
                ))}
              </div>
            )}
          </div>

          {/* Task submission */}
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-fg">New Task</label>
            <textarea
              value={taskDescription}
              onChange={handleTaskDescriptionChange}
              placeholder="Describe the task for the agent..."
              rows={3}
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 resize-none"
            />

            {/* Git options */}
            {isGitRepo && (
              <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-3">
                {/* Branch picker */}
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-fg-subtle w-16 shrink-0">Branch</label>
                  <select
                    value={selectedBranch}
                    onChange={handleBranchChange}
                    className="flex-1 rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
                  >
                    {gitInfo.branches.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Worktree toggle */}
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-fg-subtle w-16 shrink-0">Worktree</label>
                  <Switch checked={useWorktree} onCheckedChange={handleWorktreeToggle} />
                  <span className="text-xs text-fg-muted">
                    {useWorktree ? 'Isolated worktree copy' : 'Use project directory directly'}
                  </span>
                </div>
              </div>
            )}

            <div>
              <Button onClick={handleSubmitTask} isDisabled={!taskDescription.trim() || isSubmitting}>
                Submit Task
              </Button>
            </div>
          </div>

          {/* Active tasks */}
          {projectTasks.length > 0 && (
            <div className="flex flex-col gap-3">
              <span className="text-sm font-medium text-fg">Tasks ({projectTasks.length})</span>
              <div className="flex flex-col gap-2">
                {projectTasks.map((task) => (
                  <FleetTaskCard key={task.id} task={task} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
FleetProjectDetail.displayName = 'FleetProjectDetail';
