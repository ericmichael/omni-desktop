import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { ArrowSync20Regular, BranchRequest20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';
import Markdown from 'react-markdown';

import { CardSkeleton, IconButton } from '@/renderer/ds';
import type { TicketId } from '@/shared/types';

import { ticketApi } from './state';

const POLL_INTERVAL_MS = 5_000;

const useStyles = makeStyles({
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: tokens.spacingVerticalM,
  },
  emptyIcon: {
    color: tokens.colorNeutralForeground3,
  },
  emptyText: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
    height: '100%',
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXL,
    maxWidth: '48rem',
  },
  prTitle: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground1,
    lineHeight: '1.25',
  },
  prBodyWrapper: {
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    paddingTop: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground2,
  },
  ciSection: {
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    paddingTop: tokens.spacingVerticalL,
  },
  ciHeading: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: tokens.spacingVerticalS,
  },
  ciBody: {
    maxWidth: 'none',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2,
  },
});

export const TicketPROverview = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [prBody, setPrBody] = useState<string | null>(null);
  const [ciStatus, setCiStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [titleRes, bodyRes, ciRes] = await Promise.all([
        ticketApi.readArtifact(ticketId, 'pr/PR_TITLE.md').catch(() => null),
        ticketApi.readArtifact(ticketId, 'pr/PR_BODY.md').catch(() => null),
        ticketApi.readArtifact(ticketId, 'pr/CI_STATUS.md').catch(() => null),
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
    return <CardSkeleton cards={3} />;
  }

  const hasContent = prTitle || prBody || ciStatus;

  if (!hasContent) {
    return (
      <div className={styles.emptyState}>
        <BranchRequest20Regular style={{ width: 32, height: 32 }} className={styles.emptyIcon} />
        <p className={styles.emptyText}>PR description will appear here when the agent creates it</p>
        <IconButton aria-label="Refresh" icon={<ArrowSync20Regular />} size="sm" onClick={handleRefresh} />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* PR Title */}
      {prTitle && <h1 className={styles.prTitle}>{prTitle}</h1>}

      {/* PR Body */}
      {prBody && (
        <div className={`prose prose-invert prose-sm max-w-none ${styles.prBodyWrapper} [&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg [&_strong]:text-fg [&_a]:text-accent-400 [&_code]:text-fg [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-surface-raised [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_li]:marker:text-fg-subtle`}>
          <Markdown>{prBody}</Markdown>
        </div>
      )}

      {/* CI Status */}
      {ciStatus && (
        <div className={styles.ciSection}>
          <h3 className={styles.ciHeading}>CI Status</h3>
          <div className={`prose prose-invert prose-sm max-w-none ${styles.ciBody} [&_strong]:text-fg [&_code]:text-fg [&_code]:bg-surface-overlay [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded`}>
            <Markdown>{ciStatus}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
});
TicketPROverview.displayName = 'TicketPROverview';
