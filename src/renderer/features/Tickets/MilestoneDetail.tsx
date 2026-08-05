import { useStore } from '@nanostores/react';
import { Archive, Check, Edit, Ellipsis, PlayCircle, Trash2 } from 'lucide-react';
import React, { memo, useCallback, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import type { MilestoneId, ProjectId } from '@/shared/types';

import { MilestoneForm } from './MilestoneForm';
import { $activeMilestoneId, ticketApi } from './state';
import { WorkItemsList } from './WorkItemsList';

type MilestoneDetailProps = {
  milestoneId: MilestoneId;
  projectId: ProjectId;
  /** Mobile: the TopAppBar already shows back + milestone title. */
  hideChrome?: boolean;
};

export const MilestoneDetail = memo(({ milestoneId, projectId, hideChrome }: MilestoneDetailProps) => {
  const milestones = useStore($milestones);
  const milestone = milestones[milestoneId];

  const [editOpen, setEditOpen] = useState(false);
  const openEdit = useCallback(() => setEditOpen(true), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);

  // Force filter to this milestone
  useMemo(() => {
    $activeMilestoneId.set(milestoneId);
  }, [milestoneId]);

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
    ticketApi.goToProject(projectId, 'tasks');
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
    const cls = days < 0 ? '[color:var(--destructive)]' : days <= 7 ? 'text-warning' : undefined;
    return { text, cls };
  })();

  // Project name lives in the breadcrumb root now — the eyebrow only carries
  // milestone metadata.
  const eyebrowParts: React.ReactNode[] = [];
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
      <span className="inline-flex items-center gap-1">
        {eyebrowParts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-muted-foreground">·</span>}
            {part}
          </React.Fragment>
        ))}
      </span>
    ) : undefined;

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Milestone actions">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={openEdit}>
            <Edit />
            Edit milestone
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {milestone.status === 'active' ? (
            <>
              <DropdownMenuItem onClick={handleComplete}>
                <Check />
                Complete
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleArchive}>
                <Archive />
                Archive
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={handleReactivate}>
              <PlayCircle />
              Reactivate
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleDelete}>
            <Trash2 />
            Delete milestone
          </DropdownMenuItem>
        </DropdownMenuContent>
      </>
    </DropdownMenu>
  );

  return (
    <div className="flex flex-col h-full w-full">
      <WorkItemsList
        projectId={projectId}
        pageTitle={milestone.title}
        contextLabel={eyebrow}
        rightActions={overflowMenu}
        hideChrome={hideChrome}
      />

      <Dialog open={editOpen} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Milestone</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <MilestoneForm projectId={projectId} editMilestone={milestone} onClose={closeEdit} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
MilestoneDetail.displayName = 'MilestoneDetail';
