import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useMemo } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { requestPreviewOpen } from '@/renderer/features/Tickets/preview-bridge';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { Project, ProjectSource, PullRequestLink, Ticket } from '@/shared/types';

const useStyles = makeStyles({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalM,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '96px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalM,
    alignItems: 'baseline',
  },
  key: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  value: {
    minWidth: 0,
    overflowWrap: 'anywhere',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  itemText: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  itemTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  itemMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
  },
  footerGroup: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
  },
});

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
    const styles = useStyles();
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
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>{source.mountName}</DialogHeader>
          <DialogBody className={styles.body}>
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Source</span>
              <div className={styles.panel}>
                <div className={styles.row}>
                  <span className={styles.key}>Kind</span>
                  <span className={styles.value}>{source.kind}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.key}>Location</span>
                  <span className={styles.value}>{sourceLocation(source)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.key}>Mount</span>
                  <span className={styles.value}>/workspace/{source.mountName}</span>
                </div>
                {source.kind === 'git-remote' && source.defaultBranch && (
                  <div className={styles.row}>
                    <span className={styles.key}>Branch</span>
                    <span className={styles.value}>{source.defaultBranch}</span>
                  </div>
                )}
              </div>
            </div>

            <div className={styles.section}>
              <span className={styles.sectionTitle}>Pull Requests</span>
              <div className={styles.panel}>
                {pullRequests.length === 0 ? (
                  <span className={styles.empty}>No pull requests linked to this source yet.</span>
                ) : (
                  pullRequests.map((pr) => (
                    <PullRequestRow key={pr.url} pullRequest={pr} onOpen={handleOpenPullRequest} />
                  ))
                )}
              </div>
            </div>

            <div className={styles.section}>
              <span className={styles.sectionTitle}>Linked Tickets</span>
              <div className={styles.panel}>
                {relatedTickets.length === 0 ? (
                  <span className={styles.empty}>No tickets have linked PRs for this source.</span>
                ) : (
                  relatedTickets.map((ticket) => (
                    <TicketRow key={ticket.id} ticket={ticket} onOpen={handleOpenTicket} />
                  ))
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter className={styles.footer}>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <div className={styles.footerGroup}>
              <Button variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="destructive" onClick={onRemove}>
                Remove
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
SourceDetailDialog.displayName = 'SourceDetailDialog';

const PullRequestRow = memo(
  ({ pullRequest, onOpen }: { pullRequest: PullRequestLink; onOpen: (url: string) => void }) => {
    const styles = useStyles();
    const handleOpen = useCallback(() => onOpen(pullRequest.url), [onOpen, pullRequest.url]);
    return (
      <div className={styles.item}>
        <div className={styles.itemText}>
          <span className={styles.itemTitle}>{pullRequest.title || `PR #${pullRequest.number}`}</span>
          <span className={styles.itemMeta}>
            PR #{pullRequest.number}
            {pullRequest.branch ? ` · ${pullRequest.branch}` : ''}
            {pullRequest.sessionId ? ` · session ${pullRequest.sessionId.slice(0, 8)}` : ''} · seen{' '}
            {new Date(pullRequest.lastSeenAt).toLocaleString()}
          </span>
        </div>
        <Button size="sm" variant="ghost" leftIcon={<Open16Regular />} onClick={handleOpen}>
          Open
        </Button>
      </div>
    );
  }
);
PullRequestRow.displayName = 'PullRequestRow';

const TicketRow = memo(({ ticket, onOpen }: { ticket: Ticket; onOpen: (ticketId: string) => void }) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => onOpen(ticket.id), [onOpen, ticket.id]);
  return (
    <div className={styles.item}>
      <div className={styles.itemText}>
        <span className={styles.itemTitle}>{ticket.title}</span>
        <span className={styles.itemMeta}>{ticket.phase || ticket.priority}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={handleOpen}>
        Open
      </Button>
    </div>
  );
});
TicketRow.displayName = 'TicketRow';
