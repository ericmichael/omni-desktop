import { memo, useCallback, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { PiArrowsClockwiseBold, PiGitPullRequestBold } from 'react-icons/pi';

import { IconButton, Spinner } from '@/renderer/ds';
import type { FleetTicketId } from '@/shared/types';

import { fleetApi } from './state';

const POLL_INTERVAL_MS = 5_000;

export const FleetTicketPROverview = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [prBody, setPrBody] = useState<string | null>(null);
  const [ciStatus, setCiStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [titleRes, bodyRes, ciRes] = await Promise.all([
        fleetApi.readArtifact(ticketId, 'pr/PR_TITLE.md').catch(() => null),
        fleetApi.readArtifact(ticketId, 'pr/PR_BODY.md').catch(() => null),
        fleetApi.readArtifact(ticketId, 'pr/CI_STATUS.md').catch(() => null),
      ]);
      setPrTitle(titleRes?.textContent?.trim() ?? null);
      setPrBody(bodyRes?.textContent?.trim() ?? null);
      setCiStatus(ciRes?.textContent?.trim() ?? null);
    } catch {
      // Silently fail on poll errors
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2">
        <Spinner size="sm" />
        <span className="text-sm text-fg-muted">Loading PR details...</span>
      </div>
    );
  }

  const hasContent = prTitle || prBody || ciStatus;

  if (!hasContent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <PiGitPullRequestBold size={32} className="text-fg-subtle" />
        <p className="text-sm text-fg-muted">PR description will appear here when the agent creates it</p>
        <IconButton aria-label="Refresh" icon={<PiArrowsClockwiseBold />} size="sm" onClick={handleRefresh} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 h-full overflow-y-auto p-6 max-w-3xl">
      {/* PR Title */}
      {prTitle && <h1 className="text-xl font-bold text-fg leading-tight">{prTitle}</h1>}

      {/* PR Body */}
      {prBody && (
        <div className="prose prose-invert prose-sm max-w-none border-t border-surface-border pt-4 text-fg-muted [&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg [&_strong]:text-fg [&_a]:text-accent-400 [&_code]:text-fg [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-surface-raised [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_li]:marker:text-fg-subtle">
          <Markdown>{prBody}</Markdown>
        </div>
      )}

      {/* CI Status */}
      {ciStatus && (
        <div className="border-t border-surface-border pt-4">
          <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2">CI Status</h3>
          <div className="prose prose-invert prose-sm max-w-none bg-surface-raised rounded-lg p-3 text-fg-muted [&_strong]:text-fg [&_code]:text-fg [&_code]:bg-surface-overlay [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded">
            <Markdown>{ciStatus}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
});
FleetTicketPROverview.displayName = 'FleetTicketPROverview';
