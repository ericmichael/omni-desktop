import { useStore } from '@nanostores/react';
import { Archive, Check, ChevronDown, ChevronRight, GitFork, Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';

import { isDoneColumn } from '@/lib/pipeline-category';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { Input } from '@/renderer/ds/ui/input';
import { Progress } from '@/renderer/ds/ui/progress';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import type { Milestone, MilestoneId, ProjectId } from '@/shared/types';

import { $activeMilestoneId, $pipeline, $tickets } from './state';

type MilestoneRowProps = {
  milestone: Milestone;
  isSelected: boolean;
  isExpanded: boolean;
  progress: { done: number; total: number };
  onSelect: () => void;
  onToggle: () => void;
};

const MilestoneRow = memo(({ milestone, isSelected, isExpanded, progress, onSelect, onToggle }: MilestoneRowProps) => {
  const pct = progress.total > 0 ? progress.done / progress.total : 0;

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

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
    <Collapsible
      open={isExpanded}
      onOpenChange={(open) => {
        if (open !== isExpanded) {
          onToggle();
        }
      }}
    >
      <div
        className={`${'flex items-center gap-2 pl-5 pr-5 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left text-foreground transition-colors duration-100 hover:bg-accent'} ${isSelected ? 'bg-accent hover:bg-accent' : ''}`}
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            onClick={handleChevronClick}
            aria-label={isExpanded ? 'Collapse milestone' : 'Expand milestone'}
          >
            {isExpanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-2 p-0"
          onClick={onSelect}
        >
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-sm font-medium overflow-hidden text-ellipsis whitespace-nowrap">
              {milestone.title}
            </span>
            {!isExpanded && milestone.description && (
              <span className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                {milestone.description}
              </span>
            )}
          </div>
          {milestone.branch && (
            <span className="hidden sm:flex sm:shrink-0 sm:items-center sm:gap-1 sm:rounded-full sm:bg-chart-5/15 sm:px-1.5 sm:py-0.5 sm:text-xs sm:font-medium sm:text-chart-5">
              <GitFork className="size-3" />
              {milestone.branch}
            </span>
          )}
          {milestone.status !== 'active' && <Badge variant="secondary">{milestone.status}</Badge>}
          <div className="w-20 shrink-0">
            <p className="text-xs text-muted-foreground text-right mb-0.5">
              {progress.done}/{progress.total}
            </p>
            <Progress value={pct * 100} />
          </div>
        </Button>
      </div>

      <CollapsibleContent>
        <div className="pl-8 pr-5 pt-1 pb-4 flex flex-col gap-2 border-b border-border bg-card">
          {milestone.description && (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{milestone.description}</p>
          )}
          <div className="flex items-center gap-2">
            {milestone.status === 'active' && (
              <>
                <Button size="sm" variant="ghost" onClick={handleCompleteMilestone}>
                  <Check />
                  Complete
                </Button>
                <Button size="sm" variant="ghost" onClick={handleArchiveMilestone}>
                  <Archive />
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
      </CollapsibleContent>
    </Collapsible>
  );
});
MilestoneRow.displayName = 'MilestoneRow';

export const MilestoneSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const milestones = useStore($milestones);
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
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
      const done = milestoneTickets.filter((t) => isDoneColumn(pipeline, t.columnId)).length;
      map[milestone.id] = { done, total: milestoneTickets.length };
    }
    return map;
  }, [tickets, pipeline, projectId, projectMilestones]);

  const handleSelect = useCallback(
    (id: MilestoneId) => {
      $activeMilestoneId.set(activeMilestoneId === id ? 'all' : id);
    },
    [activeMilestoneId]
  );

  const handleToggle = useCallback((id: MilestoneId) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

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
    <div className="flex flex-col shrink-0">
      <div className="flex items-center gap-2 pl-5 pr-5 pt-2 pb-2 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Milestones</span>
        <span className="text-xs text-muted-foreground text-muted-foreground">({projectMilestones.length})</span>
        <div className="flex-1" />
        {activeMilestoneId !== 'all' && (
          <Button size="sm" variant="ghost" onClick={() => $activeMilestoneId.set('all')}>
            Show all
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New milestone"
          onClick={() => setCreating(true)}
        >
          <Plus />
        </Button>
      </div>

      {creating && (
        <div className="flex flex-col gap-2 pl-5 pr-5 pt-2 pb-2 border-b border-border bg-card">
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

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void handleCreate()} disabled={!newTitle.trim()}>
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

      <div className="flex flex-col">
        {projectMilestones.length === 0 && !creating && (
          <p className="pl-5 pr-5 pt-2 pb-2 text-xs text-muted-foreground italic">
            No milestones yet. Add one to organize your work.
          </p>
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
