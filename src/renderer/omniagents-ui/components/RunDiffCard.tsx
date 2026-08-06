import { FileDiffIcon } from 'lucide-react';
import React from 'react';

import type { RunDiffItem } from '@/shared/chat-types';

import { Artifact, ArtifactContent, ArtifactHeader, ArtifactTitle } from './ai/artifact';
import { CodeBlock } from './ai/code-block';

/** Durable run-diff presentation with explicit partial/opaque states. */
export function RunDiffCard({ item }: { item: RunDiffItem }) {
  const hasTextDiff = item.diff.trim().length > 0;
  const allOpaque = item.files.length > 0 && item.files.every((file) => file.opaque);
  const changedSummary = `${item.stats.filesChanged} ${item.stats.filesChanged === 1 ? 'file' : 'files'} changed`;
  return (
    <Artifact data-conversation-kind="run_diff">
      <ArtifactHeader>
        <ArtifactTitle>
          <span className="flex items-center gap-2">
            <FileDiffIcon className="size-4" aria-hidden="true" />
            Run changes
          </span>
        </ArtifactTitle>
      </ArtifactHeader>
      <ArtifactContent className="space-y-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{changedSummary}</span>
          <span className="text-success">+{item.stats.additions}</span>
          <span className="text-destructive">−{item.stats.deletions}</span>
        </div>
        {item.truncated || item.filesTruncated ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {item.truncated && item.filesTruncated
              ? 'The textual diff and file list are truncated.'
              : item.truncated
                ? 'The textual diff is truncated.'
                : 'The file list is truncated.'}
          </div>
        ) : null}
        {item.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workspace file changes were captured for this run.</p>
        ) : (
          <ul className="space-y-1.5">
            {item.files.map((file) => (
              <li key={file.path} className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                <span className="shrink-0 font-medium uppercase text-muted-foreground">{file.changeType}</span>
                <span className="min-w-0 break-all font-mono text-foreground">{file.path}</span>
                {file.opaque ? <span className="text-warning">binary or oversized; no text hunks</span> : null}
                {file.baselineUnknown ? <span className="text-warning">baseline unavailable</span> : null}
              </li>
            ))}
          </ul>
        )}
        {hasTextDiff ? (
          <CodeBlock code={item.diff} language="diff" />
        ) : item.files.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {allOpaque
              ? 'Text diff unavailable for these binary or oversized files.'
              : 'No textual hunks are available.'}
          </p>
        ) : null}
      </ArtifactContent>
    </Artifact>
  );
}
