import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { ArrowSync20Regular, BranchCompare20Regular,BranchRequest20Regular, Checkmark20Filled, Delete20Regular,Dismiss20Regular,Warning20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo,useState } from 'react';
import Markdown from 'react-markdown';

import { Button, CardSkeleton, IconButton } from '@/renderer/ds';
import type { PrMergeCheck, TicketId } from '@/shared/types';

import { $tickets,ticketApi } from './state';

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
  reviewSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    paddingTop: tokens.spacingVerticalL,
  },
  sectionHeading: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  reviewActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: tokens.fontSizeBase200,
    padding: '2px 8px',
    borderRadius: tokens.borderRadiusMedium,
  },
  statusApproved: {
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
  },
  statusChanges: {
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground2,
  },
  statusMerged: {
    backgroundColor: tokens.colorPalettePurpleBackground2,
    color: tokens.colorPalettePurpleForeground2,
  },
  mergeSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    paddingTop: tokens.spacingVerticalL,
  },
  mergeStatusOk: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase300,
  },
  mergeStatusWarn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    color: tokens.colorPaletteYellowForeground2,
    fontSize: tokens.fontSizeBase300,
  },
  conflictList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  mergeMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  mergeError: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
  mergedBanner: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    ...shorthands.border('1px', 'solid', tokens.colorPalettePurpleBorderActive),
    backgroundColor: tokens.colorPalettePurpleBackground2,
    color: tokens.colorPalettePurpleForeground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
});

export const TicketPROverview = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [prBody, setPrBody] = useState<string | null>(null);
  const [ciStatus, setCiStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tickets = useStore($tickets);
  const ticket = tickets[ticketId];
  const review = ticket?.prReview;
  const mergedAt = ticket?.prMergedAt;

  const [mergeCheck, setMergeCheck] = useState<PrMergeCheck | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

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

  const refreshMergeCheck = useCallback(async () => {
    const result = await ticketApi.checkMerge(ticketId);
    setMergeCheck(result);
  }, [ticketId]);

  // Run a merge check when the tab mounts and after the review flips to approved.
  useEffect(() => {
    if (mergedAt) {
      return;
    }
    void refreshMergeCheck();
  }, [refreshMergeCheck, review?.status, mergedAt]);

  const handleRefresh = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  const handleApprove = useCallback(async () => {
    setReviewBusy(true);
    try {
      await ticketApi.setPrReview(ticketId, review?.status === 'approved' ? null : 'approved');
    } finally {
      setReviewBusy(false);
    }
  }, [ticketId, review?.status]);

  const handleRequestChanges = useCallback(async () => {
    setReviewBusy(true);
    try {
      await ticketApi.setPrReview(ticketId, review?.status === 'changes_requested' ? null : 'changes_requested');
    } finally {
      setReviewBusy(false);
    }
  }, [ticketId, review?.status]);

  const handleMerge = useCallback(async () => {
    setMergeBusy(true);
    setMergeError(null);
    try {
      const result = await ticketApi.mergeTicket(ticketId);
      if (!result.ok) {
        setMergeError(result.error);
        void refreshMergeCheck();
      }
    } finally {
      setMergeBusy(false);
    }
  }, [ticketId, refreshMergeCheck]);

  const handleCleanup = useCallback(async () => {
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      const ok = await ticketApi.finalizeTicketCleanup(ticketId);
      if (!ok) {
        setCleanupError('Worktree still has uncommitted changes. Commit or discard them first.');
      }
    } finally {
      setCleanupBusy(false);
    }
  }, [ticketId]);

  const canMerge = useMemo(
    () =>
      !mergedAt &&
      review?.status === 'approved' &&
      mergeCheck !== null &&
      mergeCheck.ready &&
      !mergeCheck.hasConflicts &&
      mergeCheck.ahead > 0,
    [mergedAt, review?.status, mergeCheck]
  );

  // You can only review when there's committed work that would land in the
  // merge. Pre-merge check, no-worktree tickets, or zero-ahead branches all
  // mean the review buttons don't make sense.
  const canReview = useMemo(
    () => !mergedAt && mergeCheck !== null && mergeCheck.ready && mergeCheck.ahead > 0,
    [mergedAt, mergeCheck]
  );

  if (loading) {
    return <CardSkeleton cards={3} />;
  }

  const hasContent = prTitle || prBody || ciStatus;

  if (!hasContent && !ticket) {
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
      {prTitle ? (
        <h1 className={styles.prTitle}>{prTitle}</h1>
      ) : (
        <p className={styles.emptyText}>
          <em>No PR title yet — agent will write `pr/PR_TITLE.md` as it works.</em>
        </p>
      )}

      {/* PR Body */}
      {prBody ? (
        <div className={`prose prose-invert prose-sm max-w-none ${styles.prBodyWrapper} [&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg [&_strong]:text-fg [&_a]:text-accent-400 [&_code]:text-fg [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-surface-raised [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_li]:marker:text-fg-subtle`}>
          <Markdown>{prBody}</Markdown>
        </div>
      ) : null}

      {/* Merged banner — shown in place of the review/merge UI once merged */}
      {mergedAt && (
        <div className={styles.mergedBanner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
            <BranchCompare20Regular />
            Merged
          </div>
          {mergeCheck?.ready && (
            <span className={styles.mergeMeta}>
              <code>{mergeCheck.feature}</code> → <code>{mergeCheck.base}</code>
            </span>
          )}
          <span className={styles.mergeMeta}>{new Date(mergedAt).toLocaleString()}</span>
          {ticket?.worktreePath && (
            <>
              <span className={styles.mergeMeta}>
                Worktree still on disk at <code>{ticket.worktreePath}</code>
              </span>
              {cleanupError && <span className={styles.mergeError}>{cleanupError}</span>}
              <div className={styles.reviewActions}>
                <Button
                  size="sm"
                  onClick={handleCleanup}
                  isDisabled={cleanupBusy}
                  leftIcon={<Delete20Regular />}
                >
                  {cleanupBusy ? 'Cleaning up…' : 'Clean up worktree'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Review */}
      {!mergedAt && (
        <div className={styles.reviewSection}>
          <h3 className={styles.sectionHeading}>Review</h3>
          <div className={styles.reviewActions}>
            <Button
              size="sm"
              variant={review?.status === 'approved' ? 'primary' : 'ghost'}
              onClick={handleApprove}
              isDisabled={reviewBusy || !canReview}
              leftIcon={<Checkmark20Filled />}
            >
              {review?.status === 'approved' ? 'Approved' : 'Approve'}
            </Button>
            <Button
              size="sm"
              variant={review?.status === 'changes_requested' ? 'primary' : 'ghost'}
              onClick={handleRequestChanges}
              isDisabled={reviewBusy || !canReview}
              leftIcon={<Dismiss20Regular />}
            >
              {review?.status === 'changes_requested' ? 'Changes requested' : 'Request changes'}
            </Button>
            {review && (
              <span className={styles.mergeMeta}>
                {review.status === 'approved' ? 'Approved' : 'Changes requested'} ·{' '}
                {new Date(review.at).toLocaleString()}
              </span>
            )}
            {!canReview && mergeCheck?.ready && mergeCheck.ahead === 0 && !review && (
              <span className={styles.mergeMeta}>Nothing to review yet — no commits on the feature branch.</span>
            )}
          </div>
        </div>
      )}

      {/* Merge */}
      {!mergedAt && (
        <div className={styles.mergeSection}>
          <h3 className={styles.sectionHeading}>Merge</h3>
          {mergeCheck === null ? (
            <span className={styles.mergeMeta}>Checking merge…</span>
          ) : !mergeCheck.ready ? (
            <span className={styles.mergeMeta}>{mergeCheck.reason}</span>
          ) : (
            <>
              <span className={styles.mergeMeta}>
                Merging <code>{mergeCheck.feature}</code> → <code>{mergeCheck.base}</code>
                {mergeCheck.ahead > 0 && (
                  <>
                    {' '}
                    · {mergeCheck.ahead} commit{mergeCheck.ahead === 1 ? '' : 's'}
                  </>
                )}
              </span>
              {mergeCheck.ahead === 0 ? (
                <span className={styles.mergeMeta}>
                  Nothing to merge — <code>{mergeCheck.base}</code> already contains every commit from{' '}
                  <code>{mergeCheck.feature}</code>.
                </span>
              ) : mergeCheck.hasConflicts ? (
                <>
                  <span className={styles.mergeStatusWarn}>
                    <Warning20Filled />
                    {mergeCheck.conflictingFiles.length > 0
                      ? `${mergeCheck.conflictingFiles.length} conflicting file${mergeCheck.conflictingFiles.length === 1 ? '' : 's'}`
                      : 'Merge has conflicts'}
                  </span>
                  {mergeCheck.conflictingFiles.length > 0 && (
                    <ul className={styles.conflictList}>
                      {mergeCheck.conflictingFiles.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <span className={styles.mergeStatusOk}>
                  <Checkmark20Filled />
                  Ready to merge
                </span>
              )}
            </>
          )}
          {mergeError && <span className={styles.mergeError}>{mergeError}</span>}
          <div className={styles.reviewActions}>
            <Button
              size="sm"
              onClick={handleMerge}
              isDisabled={!canMerge || mergeBusy}
              leftIcon={<BranchCompare20Regular />}
            >
              {mergeBusy ? 'Merging…' : 'Merge branch'}
            </Button>
            <IconButton
              aria-label="Re-check merge"
              icon={<ArrowSync20Regular />}
              size="sm"
              onClick={refreshMergeCheck}
            />
            {review?.status !== 'approved' && !mergedAt && (
              <span className={styles.mergeMeta}>Approve the PR to enable merging.</span>
            )}
          </div>
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
