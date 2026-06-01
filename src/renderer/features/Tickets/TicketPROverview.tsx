import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  BranchRequest20Regular,
  Checkmark20Filled,
  Delete20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';

import { Button, CardSkeleton, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ContainerPullRequest, PrMergeCheck, ProjectSource, TicketId } from '@/shared/types';

import { PullRequestBadge } from './PullRequestBadge';
import { $tickets, ticketApi } from './state';

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
  emptyIcon: { color: tokens.colorNeutralForeground3 },
  emptyText: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
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
  changesHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
    paddingTop: tokens.spacingVerticalL,
  },
  changesHeaderLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  changesHeading: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  changesSummary: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  reviewSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
  sectionHeading: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  sectionHeadingRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  reviewActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  mergeSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
  },
  mergeStatusOk: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    color: tokens.colorPaletteGreenForeground1,
    fontSize: tokens.fontSizeBase300,
  },
  mergeMeta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  mergeError: { fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteRedForeground1 },
  untouchedNote: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  worktreeBanner: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
});

/** Map of sourceId → latest merge check result (null = still loading). */
type MergeChecks = Record<string, PrMergeCheck | null>;

/** Map of sourceId → detected GitHub PR (null = none / not yet detected). */
type PrLinks = Record<string, ContainerPullRequest | null>;

/** Whether a source has changes the user can sync to the host. */
function isTouched(check: PrMergeCheck | null | undefined): boolean {
  return !!(check && check.ready && check.ahead > 0);
}

/**
 * Per-source "sync to host" card. Stateless w.r.t. the merge check — the parent
 * owns ``mergeChecks`` so it can compute roll-up counts and orchestrate "Sync
 * all". The card calls ``onMergeCheckRefresh`` after a sync attempt to keep the
 * parent's state fresh. When the agent has opened a PR for the source's branch,
 * a clickable PR badge opens it in the built-in browser.
 */
const TicketPRSourceCard = memo(
  ({
    ticketId,
    source,
    mergeCheck,
    pullRequest,
    onMergeCheckRefresh,
  }: {
    ticketId: TicketId;
    source: ProjectSource;
    mergeCheck: PrMergeCheck | null;
    pullRequest: ContainerPullRequest | null;
    onMergeCheckRefresh: (sourceId: string) => Promise<void>;
  }) => {
    const styles = useStyles();
    const tickets = useStore($tickets);
    const ticket = tickets[ticketId];
    const syncedAt = ticket?.prMergedAt?.[source.id];

    const [syncBusy, setSyncBusy] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);

    const handleSync = useCallback(async () => {
      setSyncBusy(true);
      setSyncError(null);
      try {
        const result = await ticketApi.mergeTicket(ticketId, source.id);
        if (!result.ok) {
          setSyncError(result.error);
          void onMergeCheckRefresh(source.id);
        }
      } finally {
        setSyncBusy(false);
      }
    }, [ticketId, source.id, onMergeCheckRefresh]);

    const handleRefresh = useCallback(
      () => onMergeCheckRefresh(source.id),
      [onMergeCheckRefresh, source.id]
    );

    // Sync is idempotent + repeatable (container is authoritative), so it
    // stays available even after a prior sync — no gate on ``syncedAt``.
    const canSync =
      mergeCheck !== null && mergeCheck.ready && !mergeCheck.hasConflicts && mergeCheck.ahead > 0;

    const sourceLocation =
      source.kind === 'local'
        ? source.workspaceDir
        : source.kind === 'git-remote'
          ? source.repoUrl
          : '';

    return (
      <div className={styles.reviewSection}>
        <div className={styles.sectionHeadingRow}>
          <h3 className={styles.sectionHeading}>{source.mountName}</h3>
          <div className={styles.reviewActions}>
            {pullRequest && <PullRequestBadge pr={pullRequest} />}
            <span className={styles.mergeMeta} title={sourceLocation}>
              {source.kind}
            </span>
          </div>
        </div>
        <div className={styles.mergeSection}>
          {mergeCheck === null ? (
            <span className={styles.mergeMeta}>Checking for changes…</span>
          ) : !mergeCheck.ready ? (
            <span className={styles.mergeMeta}>{mergeCheck.reason}</span>
          ) : (
            <span className={styles.mergeStatusOk}>
              <Checkmark20Filled />
              {mergeCheck.ahead} file{mergeCheck.ahead === 1 ? '' : 's'} to sync to host
            </span>
          )}
          {syncedAt && (
            <span className={styles.mergeMeta}>Last synced {new Date(syncedAt).toLocaleString()}</span>
          )}
          {syncError && <span className={styles.mergeError}>{syncError}</span>}
          <div className={styles.reviewActions}>
            <Button
              size="sm"
              onClick={handleSync}
              isDisabled={!canSync || syncBusy}
              leftIcon={<ArrowSync20Regular />}
            >
              {syncBusy ? 'Syncing…' : syncedAt ? 'Re-sync to host' : 'Sync to host'}
            </Button>
            <IconButton
              aria-label="Re-check changes"
              icon={<ArrowSync20Regular />}
              size="sm"
              onClick={handleRefresh}
            />
          </div>
        </div>
      </div>
    );
  }
);
TicketPRSourceCard.displayName = 'TicketPRSourceCard';

export const TicketPROverview = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const [prTitle, setPrTitle] = useState<string | null>(null);
  const [prBody, setPrBody] = useState<string | null>(null);
  const [ciStatus, setCiStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tickets = useStore($tickets);
  const store = useStore(persistedStoreApi.$atom);
  const ticket = tickets[ticketId];
  const project = ticket ? store.projects.find((p) => p.id === ticket.projectId) : undefined;
  const sources = project?.sources ?? [];

  const [mergeChecks, setMergeChecks] = useState<MergeChecks>({});
  const [prLinks, setPrLinks] = useState<PrLinks>({});
  const [mergeAllBusy, setMergeAllBusy] = useState(false);
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

  const refreshOne = useCallback(
    async (sourceId: string) => {
      const [check, pr] = await Promise.all([
        ticketApi.checkMerge(ticketId, sourceId),
        ticketApi.detectPullRequest(ticketId, sourceId).catch(() => null),
      ]);
      setMergeChecks((prev) => ({ ...prev, [sourceId]: check }));
      setPrLinks((prev) => ({ ...prev, [sourceId]: pr }));
    },
    [ticketId]
  );

  const refreshAll = useCallback(async () => {
    if (sources.length === 0) return;
    await Promise.all(sources.map((s) => refreshOne(s.id)));
  }, [sources, refreshOne]);

  // Re-check whenever the source list or synced state changes.
  useEffect(() => {
    void refreshAll();
  }, [refreshAll, ticket?.prMergedAt]);

  const handleRefresh = useCallback(() => {
    void fetchData();
    void refreshAll();
  }, [fetchData, refreshAll]);

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

  // Bucket sources by their current sync state. A source is "touched" if it
  // has changes to sync or has been synced at least once; "syncable" if it has
  // changes ready to mirror (sync is repeatable, so synced sources still count).
  const { touchedSources, untouchedSources, mergedCount, syncableCount } = useMemo(() => {
    const touched: ProjectSource[] = [];
    const untouched: ProjectSource[] = [];
    let merged = 0;
    let syncable = 0;
    for (const s of sources) {
      const check = mergeChecks[s.id];
      const synced = !!ticket?.prMergedAt?.[s.id];
      if (isTouched(check) || synced) {
        touched.push(s);
        if (synced) merged += 1;
        if (check && check.ready && !check.hasConflicts && check.ahead > 0) syncable += 1;
      } else {
        untouched.push(s);
      }
    }
    return {
      touchedSources: touched,
      untouchedSources: untouched,
      mergedCount: merged,
      syncableCount: syncable,
    };
  }, [sources, mergeChecks, ticket?.prMergedAt]);

  const handleMergeAll = useCallback(async () => {
    setMergeAllBusy(true);
    try {
      for (const s of touchedSources) {
        const check = mergeChecks[s.id];
        if (!check || !check.ready || check.hasConflicts || check.ahead === 0) continue;
        const result = await ticketApi.mergeTicket(ticketId, s.id);
        if (!result.ok) {
          // Stop on first failure — user can inspect the offending card.
          void refreshOne(s.id);
          break;
        }
      }
    } finally {
      setMergeAllBusy(false);
    }
  }, [touchedSources, mergeChecks, ticketId, refreshOne]);

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

  const checksLoaded = sources.every((s) => mergeChecks[s.id] !== undefined);
  const nothingTouchedYet = checksLoaded && touchedSources.length === 0 && sources.length > 0;

  return (
    <div className={styles.root}>
      {prTitle ? (
        <h1 className={styles.prTitle}>{prTitle}</h1>
      ) : (
        <p className={styles.emptyText}>
          <em>No PR title yet — agent will write `pr/PR_TITLE.md` as it works.</em>
        </p>
      )}

      {prBody ? (
        <div className={`prose prose-invert prose-sm max-w-none ${styles.prBodyWrapper} [&_h1]:text-fg [&_h2]:text-fg [&_h3]:text-fg [&_strong]:text-fg [&_a]:text-accent-400 [&_code]:text-fg [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-surface-raised [&_pre]:rounded-lg [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_li]:marker:text-fg-subtle`}>
          <Markdown>{prBody}</Markdown>
        </div>
      ) : null}

      {ticket?.worktreePath && (
        <div className={styles.worktreeBanner}>
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
        </div>
      )}

      {sources.length === 0 ? (
        <p className={styles.emptyText}>
          <em>This project has no sources attached — nothing to sync.</em>
        </p>
      ) : (
        <>
          <div className={styles.changesHeader}>
            <div className={styles.changesHeaderLeft}>
              <span className={styles.changesHeading}>Changes</span>
              <span className={styles.changesSummary}>
                {!checksLoaded
                  ? 'Checking sources…'
                  : touchedSources.length === 0
                    ? 'No source has committed changes yet'
                    : `${mergedCount} of ${touchedSources.length} synced`}
              </span>
            </div>
            {syncableCount > 1 && (
              <Button
                size="sm"
                onClick={handleMergeAll}
                isDisabled={mergeAllBusy}
                leftIcon={<ArrowSync20Regular />}
              >
                {mergeAllBusy ? 'Syncing…' : `Sync ${syncableCount} to host`}
              </Button>
            )}
          </div>

          {nothingTouchedYet ? (
            <p className={styles.emptyText}>
              <em>Agent hasn&apos;t committed work to any source yet.</em>
            </p>
          ) : (
            touchedSources.map((source) => (
              <TicketPRSourceCard
                key={source.id}
                ticketId={ticketId}
                source={source}
                mergeCheck={mergeChecks[source.id] ?? null}
                pullRequest={prLinks[source.id] ?? null}
                onMergeCheckRefresh={refreshOne}
              />
            ))
          )}

          {untouchedSources.length > 0 && touchedSources.length > 0 && (
            <span className={styles.untouchedNote}>
              {untouchedSources.length} source{untouchedSources.length === 1 ? '' : 's'} untouched:{' '}
              {untouchedSources.map((s) => s.mountName).join(', ')}
            </span>
          )}
        </>
      )}

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
