import { ExternalLink } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { requestPreviewOpen } from '@/renderer/features/Tickets/preview-bridge';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { Project, ProjectSource, PullRequestLink, Ticket } from '@/shared/types';

type SourceDetailDialogProps = {
  open: boolean;
  onClose: () => void;
  project: Project;
  source: ProjectSource;
  tickets: Ticket[];
  onEdit: () => void;
  onRemove: () => void;
};

const sourceLocation = (source: ProjectSource): string =>
  source.kind === 'local' ? source.workspaceDir : source.repoUrl;

export const SourceDetailDialog = memo(
  ({ open, onClose, project, source, tickets, onEdit, onRemove }: SourceDetailDialogProps) => {
    const relatedTickets = useMemo(
      () =>
        tickets.filter(
          (ticket) => ticket.projectId === project.id && ticket.pullRequests?.some((pr) => pr.sourceId === source.id)
        ),
      [project.id, source.id, tickets]
    );
    const pullRequests = useMemo(() => {
      const byUrl = new Map<string, PullRequestLink>();
      for (const ticket of tickets) {
        if (ticket.projectId !== project.id) {
          continue;
        }
        for (const pr of ticket.pullRequests ?? []) {
          if (pr.sourceId === source.id) {
            byUrl.set(pr.url, pr);
          }
        }
      }
      return [...byUrl.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }, [project.id, source.id, tickets]);

    const handleOpenPullRequest = useCallback((url: string) => requestPreviewOpen(url), []);
    const handleOpenTicket = useCallback((ticketId: string) => ticketApi.goToTicket(ticketId), []);

    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{source.mountName}</DialogTitle>
          </DialogHeader>
          <div className={cn('min-h-0 overflow-y-auto', 'flex flex-col gap-4')}>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Source</span>
              <div className="flex flex-col gap-2 border border-border rounded-lg bg-card p-4">
                <div className="flex items-baseline gap-4">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">Kind</span>
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm text-foreground">{source.kind}</span>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">Location</span>
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm text-foreground">{sourceLocation(source)}</span>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">Mount</span>
                  <span className="min-w-0 flex-1 wrap-anywhere text-sm text-foreground">
                    /workspace/{source.mountName}
                  </span>
                </div>
                {source.kind === 'git-remote' && source.defaultBranch && (
                  <div className="flex items-baseline gap-4">
                    <span className="w-24 shrink-0 text-xs text-muted-foreground">Branch</span>
                    <span className="min-w-0 flex-1 wrap-anywhere text-sm text-foreground">{source.defaultBranch}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Pull Requests</span>
              <div className="flex flex-col gap-2 border border-border rounded-lg bg-card p-4">
                {pullRequests.length === 0 ? (
                  <span className="text-muted-foreground text-xs">No pull requests linked to this source yet.</span>
                ) : (
                  pullRequests.map((pr) => (
                    <PullRequestRow key={pr.url} pullRequest={pr} onOpen={handleOpenPullRequest} />
                  ))
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Linked tasks</span>
              <div className="flex flex-col gap-2 border border-border rounded-lg bg-card p-4">
                {relatedTickets.length === 0 ? (
                  <span className="text-muted-foreground text-xs">No tasks have linked PRs for this source.</span>
                ) : (
                  relatedTickets.map((ticket) => (
                    <TicketRow key={ticket.id} ticket={ticket} onOpen={handleOpenTicket} />
                  ))
                )}
              </div>
            </div>
          </div>
          <DialogFooter className="flex justify-between">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="destructive" onClick={onRemove}>
                Remove
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
SourceDetailDialog.displayName = 'SourceDetailDialog';

const PullRequestRow = memo(
  ({ pullRequest, onOpen }: { pullRequest: PullRequestLink; onOpen: (url: string) => void }) => {
    const handleOpen = useCallback(() => onOpen(pullRequest.url), [onOpen, pullRequest.url]);
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground font-semibold">
            {pullRequest.title || `PR #${pullRequest.number}`}
          </span>
          <span className="text-muted-foreground text-xs">
            PR #{pullRequest.number}
            {pullRequest.branch ? ` · ${pullRequest.branch}` : ''}
            {pullRequest.sessionId ? ` · session ${pullRequest.sessionId.slice(0, 8)}` : ''} · seen{' '}
            {new Date(pullRequest.lastSeenAt).toLocaleString()}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={handleOpen}>
          <ExternalLink />
          Open
        </Button>
      </div>
    );
  }
);
PullRequestRow.displayName = 'PullRequestRow';

const TicketRow = memo(({ ticket, onOpen }: { ticket: Ticket; onOpen: (ticketId: string) => void }) => {
  const handleOpen = useCallback(() => onOpen(ticket.id), [onOpen, ticket.id]);
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-foreground font-semibold">
          {ticket.title}
        </span>
        <span className="text-muted-foreground text-xs">{ticket.phase || ticket.priority}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={handleOpen}>
        Open
      </Button>
    </div>
  );
});
TicketRow.displayName = 'TicketRow';
