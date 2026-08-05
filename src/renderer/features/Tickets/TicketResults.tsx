import { ExternalLink, FileText, GitPullRequest } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { emitter } from '@/renderer/services/ipc';
import type { ArtifactFileEntry, Ticket } from '@/shared/types';

import { ticketApi } from './state';

export const TicketResults = memo(({ ticket }: { ticket: Ticket }) => {
  const [files, setFiles] = useState<ArtifactFileEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void ticketApi
      .listArtifacts(ticket.id)
      .then((entries) => {
        if (!cancelled) {
          setFiles(entries.filter((entry) => !entry.isDirectory));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ticket.id, ticket.updatedAt]);

  const pullRequests = useMemo(() => ticket.pullRequests ?? [], [ticket.pullRequests]);
  if (!pullRequests.length && !files.length) {
    return null;
  }

  return (
    <section className="mt-8 max-w-3xl" aria-labelledby="task-results-heading">
      <div className="mb-3">
        <h2 id="task-results-heading" className="text-sm font-medium">
          Results
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Files and changes created while working on this task.</p>
      </div>
      <div className="space-y-1">
        {pullRequests.map((pullRequest) => (
          <div key={pullRequest.url} className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">
              {pullRequest.title || `Change #${pullRequest.number}`}
            </span>
            <span className="text-xs text-muted-foreground">
              {pullRequest.state.toUpperCase() === 'OPEN' ? 'Ready to check' : pullRequest.state}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open change"
              onClick={() => void emitter.invoke('util:open-external', pullRequest.url)}
            >
              <ExternalLink />
            </Button>
          </div>
        ))}
        {files.map((file) => (
          <div key={file.relativePath} className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void ticketApi.openArtifactExternal(ticket.id, file.relativePath)}
            >
              Open
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
});
TicketResults.displayName = 'TicketResults';
