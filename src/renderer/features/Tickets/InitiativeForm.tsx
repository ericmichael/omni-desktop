import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { Button, Input, Select, Textarea } from '@/renderer/ds';
import { initiativeApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, Initiative, ProjectId } from '@/shared/types';

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

export const InitiativeForm = memo(({
  projectId,
  onClose,
  editInitiative,
}: {
  projectId: ProjectId;
  onClose: () => void;
  editInitiative?: Initiative;
}) => {
  const styles = useStyles();
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
    if (project.source.kind !== 'local') return;
    ticketApi.checkGitRepo(project.source.workspaceDir).then((info) => {
      setGitInfo(info);
    });
  }, [project]);

  useEffect(() => {
    setTitle(editInitiative?.title ?? '');
    setDescription(editInitiative?.description ?? '');
    setBranch(editInitiative?.branch ?? '');
  }, [editInitiative]);

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (editInitiative) {
        await initiativeApi.updateInitiative(editInitiative.id, {
          title: title.trim(),
          description: description.trim(),
          branch: gitInfo?.isGitRepo ? (branch || undefined) : undefined,
        });
      } else {
        await initiativeApi.addInitiative({
          projectId,
          title: title.trim(),
          description: description.trim(),
          status: 'active',
          ...(gitInfo?.isGitRepo && branch ? { branch } : {}),
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, branch, gitInfo, isSubmitting, projectId, onClose, editInitiative]);

  return (
    <div className={styles.root}>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Initiative title..."
        className="w-full"
        autoFocus
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description — what is this initiative delivering?"
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
      <div className={styles.actions}>
        <Button onClick={handleSubmit} isDisabled={!title.trim() || isSubmitting}>
          {editInitiative ? 'Save Initiative' : 'Create Initiative'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
});
InitiativeForm.displayName = 'InitiativeForm';
