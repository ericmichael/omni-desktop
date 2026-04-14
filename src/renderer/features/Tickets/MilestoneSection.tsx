import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  ArchiveRegular,
  BranchFork20Regular,
  Checkmark12Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { Badge, Button, Caption1, IconButton, Input, ProgressBar, SectionLabel, Textarea } from '@/renderer/ds';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import type { Milestone, MilestoneId, ProjectId } from '@/shared/types';

import { $activeMilestoneId, $tickets } from './state';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
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
  },
  flex1: {
    flex: '1 1 0',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  milestoneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
  milestoneRowSelected: {
    backgroundColor: tokens.colorSubtleBackgroundSelected,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundSelected,
    },
  },
  chevron: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  titleArea: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  titleText: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  descText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  progressWrap: {
    width: '80px',
    flexShrink: 0,
  },
  progressLabel: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    textAlign: 'right',
    marginBottom: '2px',
  },
  branchBadge: {
    display: 'none',
    '@media (min-width: 640px)': {
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
    },
  },
  expandedPanel: {
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  expandedDesc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  expandedActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  inlineForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  formRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  emptyHint: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

type MilestoneRowProps = {
  milestone: Milestone;
  isSelected: boolean;
  isExpanded: boolean;
  progress: { done: number; total: number };
  onSelect: () => void;
  onToggle: () => void;
};

const MilestoneRow = memo(({ milestone, isSelected, isExpanded, progress, onSelect, onToggle }: MilestoneRowProps) => {
  const styles = useStyles();
  const pct = progress.total > 0 ? progress.done / progress.total : 0;

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle();
    },
    [onToggle]
  );

  const handleCompleteMilestone = useCallback(() => {
    void milestoneApi.updateMilestone(milestone.id, { status: 'completed' });
  }, [milestone.id]);

  const handleArchiveMilestone = useCallback(() => {
    void milestoneApi.updateMilestone(milestone.id, { status: 'archived' });
  }, [milestone.id]);

  const handleReactivateMilestone = useCallback(() => {
    void milestoneApi.updateMilestone(milestone.id, { status: 'active' });
  }, [milestone.id]);

  const handleDelete = useCallback(() => {
    void milestoneApi.removeMilestone(milestone.id);
  }, [milestone.id]);

  return (
    <>
      <button
        type="button"
        className={`${styles.milestoneRow} ${isSelected ? styles.milestoneRowSelected : ''}`}
        onClick={onSelect}
      >
        <span className={styles.chevron} onClick={handleChevronClick} role="button" tabIndex={-1}>
          {isExpanded ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
        </span>
        <div className={styles.titleArea}>
          <span className={styles.titleText}>{milestone.title}</span>
          {!isExpanded && milestone.description && (
            <span className={styles.descText}>{milestone.description}</span>
          )}
        </div>
        {milestone.branch && (
          <span className={styles.branchBadge}>
            <BranchFork20Regular style={{ width: 12, height: 12 }} />
            {milestone.branch}
          </span>
        )}
        {milestone.status !== 'active' && (
          <Badge color={milestone.status === 'completed' ? 'green' : 'default'}>{milestone.status}</Badge>
        )}
        <div className={styles.progressWrap}>
          <p className={styles.progressLabel}>
            {progress.done}/{progress.total}
          </p>
          <ProgressBar value={pct} thickness="medium" color={pct >= 1 ? 'success' : 'brand'} />
        </div>
      </button>

      {isExpanded && (
        <div className={styles.expandedPanel}>
          {milestone.description && <p className={styles.expandedDesc}>{milestone.description}</p>}
          <div className={styles.expandedActions}>
            {milestone.status === 'active' && (
              <>
                <Button size="sm" variant="ghost" leftIcon={<Checkmark12Regular />} onClick={handleCompleteMilestone}>
                  Complete
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<ArchiveRegular />} onClick={handleArchiveMilestone}>
                  Archive
                </Button>
              </>
            )}
            {milestone.status !== 'active' && (
              <Button size="sm" variant="ghost" onClick={handleReactivateMilestone}>
                Reactivate
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </>
  );
});
MilestoneRow.displayName = 'MilestoneRow';

export const MilestoneSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const milestones = useStore($milestones);
  const tickets = useStore($tickets);
  const activeMilestoneId = useStore($activeMilestoneId);
  const [expandedId, setExpandedId] = useState<MilestoneId | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const projectMilestones = useMemo(
    () =>
      Object.values(milestones)
        .filter((m) => m.projectId === projectId)
        .sort((a, b) => {
          // Active first, then completed, then archived
          const order = { active: 0, completed: 1, archived: 2 };
          const diff = order[a.status] - order[b.status];
          if (diff !== 0) {
return diff;
}
          return a.createdAt - b.createdAt;
        }),
    [milestones, projectId]
  );

  const progressByMilestone = useMemo(() => {
    const map: Record<string, { done: number; total: number }> = {};
    const allTickets = Object.values(tickets).filter((t) => t.projectId === projectId);
    for (const milestone of projectMilestones) {
      const milestoneTickets = allTickets.filter((t) => t.milestoneId === milestone.id);
      const done = milestoneTickets.filter((t) => t.resolution != null).length;
      map[milestone.id] = { done, total: milestoneTickets.length };
    }
    return map;
  }, [tickets, projectId, projectMilestones]);

  const handleSelect = useCallback(
    (id: MilestoneId) => {
      $activeMilestoneId.set(activeMilestoneId === id ? 'all' : id);
    },
    [activeMilestoneId]
  );

  const handleToggle = useCallback(
    (id: MilestoneId) => {
      setExpandedId((prev) => (prev === id ? null : id));
    },
    []
  );

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) {
      setCreating(false);
      return;
    }
    await milestoneApi.addMilestone({
      projectId,
      title,
      description: newDesc.trim(),
      status: 'active',
    });
    setNewTitle('');
    setNewDesc('');
    setCreating(false);
  }, [newTitle, newDesc, projectId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleCreate();
      } else if (e.key === 'Escape') {
        setCreating(false);
        setNewTitle('');
        setNewDesc('');
      }
    },
    [handleCreate]
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <SectionLabel>Milestones</SectionLabel>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>({projectMilestones.length})</Caption1>
        <div className={styles.flex1} />
        {activeMilestoneId !== 'all' && (
          <Button size="sm" variant="ghost" onClick={() => $activeMilestoneId.set('all')}>
            Show all
          </Button>
        )}
        <IconButton
          aria-label="New milestone"
          icon={<Add20Regular />}
          size="sm"
          onClick={() => setCreating(true)}
        />
      </div>

      {creating && (
        <div className={styles.inlineForm}>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Milestone title..."
            autoFocus
          />
          <Textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="What is this milestone delivering? (optional)"
            rows={2}
          />
          <div className={styles.formRow}>
            <Button size="sm" onClick={() => void handleCreate()} isDisabled={!newTitle.trim()}>
              Create
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setNewTitle('');
                setNewDesc('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className={styles.list}>
        {projectMilestones.length === 0 && !creating && (
          <p className={styles.emptyHint}>No milestones yet. Add one to organize your work.</p>
        )}
        {projectMilestones.map((milestone) => (
          <MilestoneRow
            key={milestone.id}
            milestone={milestone}
            isSelected={activeMilestoneId === milestone.id}
            isExpanded={expandedId === milestone.id}
            progress={progressByMilestone[milestone.id] ?? { done: 0, total: 0 }}
            onSelect={() => handleSelect(milestone.id)}
            onToggle={() => handleToggle(milestone.id)}
          />
        ))}
      </div>
    </div>
  );
});
MilestoneSection.displayName = 'MilestoneSection';
