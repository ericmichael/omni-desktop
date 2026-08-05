import { CircleCheck, ExternalLink } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import type { ContainerPullRequest } from '@/shared/types';

import { requestPreviewOpen } from './preview-bridge';

/**
 * Clickable "PR #N" badge that opens the pull request in the built-in browser
 * (same bridge the agent's ``browser_open`` tool uses). Shared by the Changes
 * panel and the per-source Files Changed view (ticket + code-tab scopes).
 * Merged PRs render as a green ✓ "Merged #N" badge instead of vanishing.
 */
export const PullRequestBadge = memo(({ pr, tabId }: { pr: ContainerPullRequest; tabId?: string }) => {
  const merged = pr.state === 'MERGED';
  const numberLabel = merged ? `Merged #${pr.number}` : `PR #${pr.number}`;
  const label = pr.sourceMountName ? `${pr.sourceMountName} · ${numberLabel}` : numberLabel;
  const title = [pr.title, pr.sourceMountName, pr.branch, pr.url].filter(Boolean).join(' · ');
  const handleOpen = useCallback(
    () => (tabId === undefined ? requestPreviewOpen(pr.url) : requestPreviewOpen(pr.url, tabId)),
    [pr.url, tabId]
  );
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      title={title || pr.url}
      onClick={handleOpen}
      className={
        merged
          ? 'h-auto rounded-full border-success px-2 py-0.5 text-success hover:bg-accent'
          : 'h-auto rounded-full border-primary px-2 py-0.5 text-primary hover:bg-accent'
      }
    >
      {merged ? <CircleCheck /> : <ExternalLink />}
      {label}
    </Button>
  );
});
PullRequestBadge.displayName = 'PullRequestBadge';
