import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft20Regular,
  BranchFork20Regular,
  Calendar20Regular,
  Checkmark12Regular,
  ArchiveRegular,
  Delete20Regular,
} from '@fluentui/react-icons';
import { makeStyles, tokens, shorthands } from '@fluentui/react-components';

import { Badge, Button, Caption1, IconButton, ProgressBar, Subtitle2 } from '@/renderer/ds';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { MilestoneId, ProjectId } from '@/shared/types';

import { WorkItemsList } from './WorkItemsList';
import { $activeMilestoneId, ticketApi } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
    // Allow the title child to shrink and ellipsize instead of pushing the
    // branch/due badges off-screen.
    minWidth: 0,
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: '1 1 auto',
  },
  backBtn: {
    '@media (max-width: 639px)': {
      display: 'none',
    },
  },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    flexShrink: 0,
  },
  description: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  progressRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  progressBar: {
    flex: '1 1 0',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  branchBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorPalettePurpleBackground2,
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorPalettePurpleForeground2,
    flexShrink: 0,
    maxWidth: '180px',
    minWidth: 0,
    overflow: 'hidden',
  },
  branchText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  dueBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    borderRadius: '9999px',
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightMedium,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  dueOk: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  dueSoon: {
    backgroundColor: tokens.colorPaletteYellowBackground2,
    color: tokens.colorPaletteYellowForeground2,
  },
  dueOverdue: {
    backgroundColor: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground2,
  },
  body: {
    flex: '1 1 0',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
});

type MilestoneDetailProps = {
  milestoneId: MilestoneId;
  projectId: ProjectId;
};

export const MilestoneDetail = memo(({ milestoneId, projectId }: MilestoneDetailProps) => {
  const styles = useStyles();
  const milestones = useStore($milestones);
  const store = useStore(persistedStoreApi.$atom);
  const milestone = milestones[milestoneId];
  const project = useMemo(() => store.projects.find((entry) => entry.id === projectId) ?? null, [store.projects, projectId]);

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

  if (!milestone) return null;

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <IconButton aria-label="Back" icon={<ArrowLeft20Regular />} size="sm" onClick={handleBack} className={styles.backBtn} />
        <div className={styles.titleBlock}>
          {project && <Caption1>{project.label}</Caption1>}
          <Subtitle2 className={styles.title}>{milestone.title}</Subtitle2>
        </div>
        {milestone.status !== 'active' && (
          <Badge color={milestone.status === 'completed' ? 'green' : 'default'}>{milestone.status}</Badge>
        )}
        {milestone.branch && (
          <span className={styles.branchBadge}>
            <BranchFork20Regular style={{ width: 12, height: 12, flexShrink: 0 }} />
            <span className={styles.branchText}>{milestone.branch}</span>
          </span>
        )}
        {milestone.dueDate !== undefined && (() => {
          const days = Math.ceil((milestone.dueDate - Date.now()) / (24 * 60 * 60 * 1000));
          const cls =
            days < 0 ? styles.dueOverdue : days <= 7 ? styles.dueSoon : styles.dueOk;
          const label =
            days < 0 ? `Overdue by ${Math.abs(days)}d` :
            days === 0 ? 'Due today' :
            days === 1 ? 'Due tomorrow' :
            `Due in ${days}d`;
          return (
            <span className={`${styles.dueBadge} ${cls}`}>
              <Calendar20Regular style={{ width: 12, height: 12, flexShrink: 0 }} />
              {label}
            </span>
          );
        })()}
      </div>

      {/* Meta */}
      {(milestone.description || milestone.status === 'active') && (
        <div className={styles.meta}>
          {milestone.description && <p className={styles.description}>{milestone.description}</p>}
          <div className={styles.actions}>
            {milestone.status === 'active' && (
              <>
                <Button size="sm" variant="ghost" leftIcon={<Checkmark12Regular />} onClick={handleComplete}>
                  Complete
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<ArchiveRegular />} onClick={handleArchive}>
                  Archive
                </Button>
              </>
            )}
            {milestone.status !== 'active' && (
              <Button size="sm" variant="ghost" onClick={handleReactivate}>
                Reactivate
              </Button>
            )}
            <Button size="sm" variant="ghost" leftIcon={<Delete20Regular />} onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* Tickets filtered to this milestone */}
      <div className={styles.body}>
        <WorkItemsList projectId={projectId} />
      </div>
    </div>
  );
});
MilestoneDetail.displayName = 'MilestoneDetail';
