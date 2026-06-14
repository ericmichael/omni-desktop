import { makeStyles, tokens } from '@fluentui/react-components';
import {
  ArchiveRegular,
  Checkmark12Regular,
  Delete20Regular,
  Edit20Regular,
  MoreHorizontal20Filled,
  PlayCircle20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import React, { memo, useCallback, useMemo, useState } from 'react';

import {
  AnimatedDialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  IconButton,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { MilestoneId, ProjectId } from '@/shared/types';

import { MilestoneForm } from './MilestoneForm';
import { $activeMilestoneId, ticketApi } from './state';
import { WorkItemsList } from './WorkItemsList';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  /**
   * Eyebrow content passed into WorkItemsList's `contextLabel` slot. Renders
   * the project label + milestone metadata (status / branch / due) inline
   * with bullet separators, so the milestone detail page reuses the Board's
   * 2-line title block (eyebrow Caption1 + Subtitle2 title) instead of
   * stacking a separate header above it.
   */
  eyebrow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  eyebrowSep: {
    color: tokens.colorNeutralForeground4,
  },
  dueSoon: { color: tokens.colorPaletteYellowForeground1 },
  dueOverdue: { color: tokens.colorPaletteRedForeground1 },
});

type MilestoneDetailProps = {
  milestoneId: MilestoneId;
  projectId: ProjectId;
  /** Mobile: the TopAppBar already shows back + milestone title. */
  hideChrome?: boolean;
};

export const MilestoneDetail = memo(({ milestoneId, projectId, hideChrome }: MilestoneDetailProps) => {
  const styles = useStyles();
  const milestones = useStore($milestones);
  const store = useStore(persistedStoreApi.$atom);
  const milestone = milestones[milestoneId];
  const project = useMemo(
    () => store.projects.find((entry) => entry.id === projectId) ?? null,
    [store.projects, projectId]
  );

  const [editOpen, setEditOpen] = useState(false);
  const openEdit = useCallback(() => setEditOpen(true), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);

  // Force filter to this milestone
  useMemo(() => {
    $activeMilestoneId.set(milestoneId);
  }, [milestoneId]);

  const handleBack = useCallback(() => {
    ticketApi.goToProject(projectId);
  }, [projectId]);

  const handleComplete = useCallback(() => {
    void milestoneApi.updateMilestone(milestoneId, { status: 'completed' });
  }, [milestoneId]);

  const handleArchive = useCallback(() => {
    void milestoneApi.updateMilestone(milestoneId, { status: 'archived' });
  }, [milestoneId]);

  const handleReactivate = useCallback(() => {
    void milestoneApi.updateMilestone(milestoneId, { status: 'active' });
  }, [milestoneId]);

  const handleDelete = useCallback(() => {
    void milestoneApi.removeMilestone(milestoneId);
    ticketApi.goToProject(projectId);
  }, [milestoneId, projectId]);

  if (!milestone) {
    return null;
  }

  const dueLabel = (() => {
    if (milestone.dueDate === undefined) {
      return null;
    }
    const days = Math.ceil((milestone.dueDate - Date.now()) / (24 * 60 * 60 * 1000));
    const text =
      days < 0
        ? `Overdue by ${Math.abs(days)}d`
        : days === 0
          ? 'Due today'
          : days === 1
            ? 'Due tomorrow'
            : `Due in ${days}d`;
    const cls = days < 0 ? styles.dueOverdue : days <= 7 ? styles.dueSoon : undefined;
    return { text, cls };
  })();

  const eyebrowParts: React.ReactNode[] = [];
  if (project) {
    eyebrowParts.push(<span key="project">{project.label}</span>);
  }
  if (milestone.status !== 'active') {
    eyebrowParts.push(<span key="status">{milestone.status}</span>);
  }
  if (milestone.branch) {
    eyebrowParts.push(<span key="branch">{milestone.branch}</span>);
  }
  if (dueLabel) {
    eyebrowParts.push(
      <span key="due" className={dueLabel.cls}>
        {dueLabel.text}
      </span>
    );
  }

  const eyebrow =
    eyebrowParts.length > 0 ? (
      <span className={styles.eyebrow}>
        {eyebrowParts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className={styles.eyebrowSep}>·</span>}
            {part}
          </React.Fragment>
        ))}
      </span>
    ) : undefined;

  const overflowMenu = (
    <Menu positioning={{ position: 'below', align: 'end' }}>
      <MenuTrigger disableButtonEnhancement>
        <IconButton aria-label="Milestone actions" icon={<MoreHorizontal20Filled />} size="sm" />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<Edit20Regular />} onClick={openEdit}>
            Edit milestone
          </MenuItem>
          <MenuDivider />
          {milestone.status === 'active' ? (
            <>
              <MenuItem icon={<Checkmark12Regular />} onClick={handleComplete}>
                Complete
              </MenuItem>
              <MenuItem icon={<ArchiveRegular />} onClick={handleArchive}>
                Archive
              </MenuItem>
            </>
          ) : (
            <MenuItem icon={<PlayCircle20Regular />} onClick={handleReactivate}>
              Reactivate
            </MenuItem>
          )}
          <MenuDivider />
          <MenuItem icon={<Delete20Regular />} onClick={handleDelete}>
            Delete milestone
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  return (
    <div className={styles.root}>
      <WorkItemsList
        projectId={projectId}
        title={milestone.title}
        contextLabel={eyebrow}
        onBack={handleBack}
        rightActions={overflowMenu}
        hideChrome={hideChrome}
      />

      <AnimatedDialog open={editOpen} onClose={closeEdit}>
        <DialogContent>
          <DialogHeader>Edit Milestone</DialogHeader>
          <DialogBody>
            <MilestoneForm projectId={projectId} editMilestone={milestone} onClose={closeEdit} />
          </DialogBody>
        </DialogContent>
      </AnimatedDialog>
    </div>
  );
});
MilestoneDetail.displayName = 'MilestoneDetail';
