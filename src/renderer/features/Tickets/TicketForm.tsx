import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Input, Select, Switch, Textarea } from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, MilestoneId, ProjectId, TicketPriority } from '@/shared/types';

import { $activeMilestoneId, $tickets, ticketApi } from './state';

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
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  fieldGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  fieldLabel: {
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

export const TicketForm = memo(({ projectId, onClose }: { projectId: ProjectId; onClose: () => void }) => {
  const styles = useStyles();
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
  const projectHasRepo = project?.source != null;

  const milestones = useStore($milestones);
  const activeMilestoneId = useStore($activeMilestoneId);
  const projectMilestones = useMemo(
    () => Object.values(milestones).filter((i) => i.projectId === projectId),
    [milestones, projectId]
  );
  const defaultMilestoneId = useMemo(
    () => (activeMilestoneId !== 'all' ? activeMilestoneId : projectMilestones[0]?.id ?? ''),
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
    if (project.source?.kind !== 'local') {
return;
}
    ticketApi.checkGitRepo(project.source.workspaceDir).then((info) => {
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
  }, [title, description, priority, blockedBy, branch, useWorktree, gitInfo, isSubmitting, projectId, milestoneId, onClose]);

  return (
    <div className={styles.root}>
      <Input
        value={title}
        onChange={handleTitleChange}
        placeholder="Ticket title..."
        className="w-full"
      />
      <Textarea
        value={description}
        onChange={handleDescriptionChange}
        placeholder="Description (optional)..."
        rows={2}
      />
      <div className={styles.fieldRow}>
        {projectMilestones.length > 1 && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Milestone</label>
            <Select
              value={milestoneId}
              onChange={(e) => setMilestoneId(e.target.value)}
              size="sm"
            >
              {projectMilestones.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Priority</label>
          <Select
            value={priority}
            onChange={handlePriorityChange}
            size="sm"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </Select>
        </div>
        {projectTickets.length > 0 && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Blocked by</label>
            <Select
              multiple
              value={blockedBy}
              onChange={handleBlockedByChange}
              size="sm"
              className="max-h-20"
            >
              {projectTickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {projectHasRepo && gitInfo?.isGitRepo && (
        <div className={styles.fieldRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Isolated worktree</label>
            <Switch checked={useWorktree} onCheckedChange={setUseWorktree} />
          </div>
          {useWorktree && (
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Branch</label>
              <Select
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                size="sm"
              >
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
      <div className={styles.actions}>
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
TicketForm.displayName = 'TicketForm';
