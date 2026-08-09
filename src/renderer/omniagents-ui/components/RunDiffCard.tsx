import { FileDiffIcon } from 'lucide-react';
import React from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import type { RunDiffFile, RunDiffItem } from '@/shared/chat-types';

import { Artifact, ArtifactContent, ArtifactHeader, ArtifactTitle } from './ai/artifact';

/** The card stays scannable in the transcript: files beyond this fold into
 *  a "+N more files" row, and the Review app shows the full record. */
const MAX_LISTED_FILES = 8;

const CHANGE_GLYPH: Record<RunDiffFile['changeType'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

const CHANGE_CLASS: Record<RunDiffFile['changeType'], string> = {
  added: 'text-success',
  modified: 'text-primary',
  deleted: 'text-destructive',
};

/**
 * Compact end-of-run summary: aggregate diffstat, the changed files with
 * per-file counts, and capture caveats. The full diff is deliberately not
 * inlined — reading changes is the Review sidecar app's job, reached via
 * the Review action.
 */
export function RunDiffCard({ item, onReview }: { item: RunDiffItem; onReview?: (item: RunDiffItem) => void }) {
  const listed = item.files.slice(0, MAX_LISTED_FILES);
  const remaining = item.files.length - listed.length;
  return (
    <Artifact data-conversation-kind="run_diff">
      <ArtifactHeader>
        <ArtifactTitle>
          <span className="flex items-center gap-2">
            <FileDiffIcon className="size-4" aria-hidden="true" />
            Run changes
            <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <span>
                {item.stats.filesChanged} {item.stats.filesChanged === 1 ? 'file' : 'files'}
              </span>
              <span className="text-success">+{item.stats.additions}</span>
              <span className="text-destructive">−{item.stats.deletions}</span>
            </span>
          </span>
        </ArtifactTitle>
        {onReview ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onReview(item)}>
            Review
          </Button>
        ) : null}
      </ArtifactHeader>
      <ArtifactContent className="space-y-2">
        {item.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspace file changes were captured for this run.</p>
        ) : (
          <ul className="space-y-1">
            {listed.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
                <span
                  className={cn('w-3 shrink-0 text-center font-mono font-semibold', CHANGE_CLASS[file.changeType])}
                  title={file.changeType}
                >
                  {CHANGE_GLYPH[file.changeType]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>
                  {file.path}
                </span>
                {file.opaque ? (
                  <span className="shrink-0 text-warning" title="Binary or oversized; no text hunks">
                    opaque
                  </span>
                ) : (
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                    <span className="text-success">+{file.additions}</span>{' '}
                    <span className="text-destructive">−{file.deletions}</span>
                  </span>
                )}
                {file.baselineUnknown ? (
                  <span className="shrink-0 text-warning" title="Baseline unavailable">
                    no baseline
                  </span>
                ) : null}
              </li>
            ))}
            {remaining > 0 || item.filesTruncated ? (
              <li className="text-xs text-muted-foreground">
                {remaining > 0
                  ? `+${remaining} more ${remaining === 1 ? 'file' : 'files'}`
                  : 'The file list is truncated.'}
                {remaining > 0 && item.filesTruncated ? ' · file list truncated' : ''}
              </li>
            ) : null}
          </ul>
        )}
        {item.truncated ? <p className="text-xs text-warning">The textual diff is truncated.</p> : null}
      </ArtifactContent>
    </Artifact>
  );
}
