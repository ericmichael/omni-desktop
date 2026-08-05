import { memo, useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/ds/ui/dialog';
import { Input } from '@/renderer/ds/ui/input';
import { Label } from '@/renderer/ds/ui/label';
import { Textarea } from '@/renderer/ds/ui/textarea';
import type { ColumnId, MilestoneId, ProjectId } from '@/shared/types';

import { ticketApi } from './state';

type ProjectTaskComposerProps = {
  projectId: ProjectId;
  milestoneId?: MilestoneId;
  columnId?: ColumnId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const ProjectTaskComposer = memo(
  ({ projectId, milestoneId, columnId, open, onOpenChange }: ProjectTaskComposerProps) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      if (!open) {
        setTitle('');
        setDescription('');
        setSubmitting(false);
      }
    }, [open]);

    const createTask = useCallback(
      async (start: boolean) => {
        const trimmedTitle = title.trim();
        if (!trimmedTitle || submitting) {
          return;
        }
        setSubmitting(true);
        try {
          const ticket = await ticketApi.addTicket({
            projectId,
            ...(milestoneId ? { milestoneId } : {}),
            title: trimmedTitle,
            description: description.trim(),
            priority: 'medium',
            blockedBy: [],
          });
          if (columnId) {
            await ticketApi.moveTicketToColumn(ticket.id, columnId);
          }
          onOpenChange(false);
          ticketApi.goToTicket(ticket.id);
          if (start) {
            ticketApi.requestStartSupervisor(ticket.id);
          }
        } finally {
          setSubmitting(false);
        }
      },
      [columnId, description, milestoneId, onOpenChange, projectId, submitting, title]
    );

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>What would you like to accomplish?</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="project-task-title">Outcome</Label>
              <Input
                id="project-task-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What should change?"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void createTask(false);
                  }
                }}
              />
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Add notes or details
              </summary>
              <div className="mt-3 grid gap-2">
                <Label htmlFor="project-task-description">Notes</Label>
                <Textarea
                  id="project-task-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Anything else Omni should know"
                  rows={4}
                />
              </div>
            </details>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => void createTask(false)} disabled={!title.trim() || submitting}>
              Add to tasks
            </Button>
            <Button onClick={() => void createTask(true)} disabled={!title.trim() || submitting}>
              Start task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
ProjectTaskComposer.displayName = 'ProjectTaskComposer';
