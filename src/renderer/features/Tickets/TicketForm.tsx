import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { Button, Input, Select, Textarea } from '@/renderer/ds';
import { $initiatives } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, InitiativeId, ProjectId, TicketPriority } from '@/shared/types';

import { $activeInitiativeId, $tickets, ticketApi } from './state';

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

  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  const initiatives = useStore($initiatives);
  const activeInitiativeId = useStore($activeInitiativeId);
  const projectInitiatives = useMemo(
    () => Object.values(initiatives).filter((i) => i.projectId === projectId),
    [initiatives, projectId]
  );
  const defaultInitiativeId = useMemo(
    () => (activeInitiativeId !== 'all' ? activeInitiativeId : projectInitiatives.find((i) => i.isDefault)?.id ?? ''),
    [activeInitiativeId, projectInitiatives]
  );
  const [initiativeId, setInitiativeId] = useState<InitiativeId>(defaultInitiativeId);

  const tickets = useStore($tickets);
  const projectTickets = useMemo(
    () => Object.values(tickets).filter((t) => t.projectId === projectId),
    [tickets, projectId]
  );

  useEffect(() => {
    if (!project) return;
    if (project.source.kind !== 'local') return;
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
        initiativeId: initiativeId || undefined,
        title: title.trim(),
        description: description.trim(),
        priority,
        blockedBy,
        ...(gitInfo?.isGitRepo && { branch }),
      });
      setTitle('');
      setDescription('');
      setPriority('medium');
      setBlockedBy([]);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, priority, blockedBy, branch, gitInfo, isSubmitting, projectId, onClose]);

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
        {projectInitiatives.length > 1 && (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Initiative</label>
            <Select
              value={initiativeId}
              onChange={(e) => setInitiativeId(e.target.value)}
              size="sm"
            >
              {projectInitiatives.map((i) => (
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
      {gitInfo?.isGitRepo && (
        <div className={styles.fieldRow}>
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
