import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { emitter } from '@/renderer/services/ipc';
import type { ContainerPullRequest } from '@/shared/types';

import { PullRequestBadge } from './PullRequestBadge';

const POLL_INTERVAL_MS = 8_000;

const useStyles = makeStyles({
  // Neutral surface so the (purple) PR badge chips stand out and the label keeps
  // matched neutral contrast in every theme. A purple left accent stripe makes
  // the strip read as a distinct callout rather than blending into the content.
  banner: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    flex: '0 0 auto',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderLeft('3px', 'solid', tokens.colorPalettePurpleBorderActive),
    backgroundColor: tokens.colorNeutralBackground2,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  // Chat view content fills its container absolutely, so the banner floats over
  // the top edge (like SessionStatusBanner) instead of taking a row in flow.
  // zIndex sits just below SessionStatusBanner (100) so a transient warning wins.
  floating: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 90,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    ...shorthands.borderLeft('3px', 'solid', tokens.colorPalettePurpleBorderActive),
    borderRadius: tokens.borderRadiusMedium,
    margin: tokens.spacingVerticalS,
    boxShadow: tokens.shadow8,
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    // Absorb the free space so the badges sit at the right edge.
    marginRight: 'auto',
  },
});

/**
 * Which surface's container to probe for pull requests. ``chat`` targets the
 * singleton chat session; ``code-tab`` targets a deck column's tab.
 */
export type PullRequestBannerScope = { kind: 'chat' } | { kind: 'code-tab'; tabId: string };

const detect = (scope: PullRequestBannerScope): Promise<ContainerPullRequest[]> =>
  scope.kind === 'chat'
    ? emitter.invoke('project:detect-chat-pull-requests')
    : emitter.invoke('project:detect-code-tab-pull-requests', scope.tabId);

/**
 * Merge a poll result into the displayed PR list. The main process already
 * gates every result against the persisted `PullRequestLink`s (ticket links or
 * the global `pullRequestLinks` store for chat / un-ticketed tabs), so a
 * MERGED PR arriving here is by definition one this launcher watched while
 * open — display it. This merge only adds presentation stickiness:
 *
 * - Everything in the poll displays.
 * - A displayed MERGED badge that drops out of detection stays (sticky ✓
 *   acknowledgement for the rest of the session).
 * - A displayed OPEN badge that drops out without merging (closed unmerged)
 *   is removed.
 *
 * Pure — exported for tests.
 */
export const mergePollResult = (prev: ContainerPullRequest[], next: ContainerPullRequest[]): ContainerPullRequest[] => {
  const nextUrls = new Set(next.map((pr) => pr.url));
  const stickyMerged = prev.filter((pr) => pr.state === 'MERGED' && !nextUrls.has(pr.url));
  return [...next, ...stickyMerged];
};

/**
 * Thin top-of-view banner that surfaces pull requests (GitHub or Azure DevOps)
 * for the chat or deck surface as clickable badges (one per PR — a
 * multi-source project can have a PR per repo). Each badge opens its PR in the
 * built-in browser. Renders nothing until a PR is detected. Merged PRs render
 * as ✓ badges and persist for the session.
 *
 * ``floating`` overlays the banner at the top edge (for the Chat view, whose
 * content fills its container absolutely); the default takes a row in flow (for
 * deck columns, which stack header → banner → content).
 */
export const PullRequestBanner = memo(({ scope, floating }: { scope: PullRequestBannerScope; floating?: boolean }) => {
  const styles = useStyles();
  const [prs, setPrs] = useState<ContainerPullRequest[]>([]);

  const key = scope.kind === 'chat' ? 'chat' : scope.tabId;
  const poll = useCallback(() => {
    detect(scope)
      .then((next) => setPrs((prev) => mergePollResult(prev, next)))
      .catch(() => {
        // Transient detection failure (container restarting, CLI hiccup):
        // keep the current badges rather than blanking the banner.
      });
    // scope is reconstructed each render; key captures its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    // Scope changed (different tab/conversation): drop the previous scope's
    // badges — sticky merged state is per-surface, not global.
    setPrs([]);
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  if (prs.length === 0) {
    return null;
  }
  const tabId = scope.kind === 'code-tab' ? scope.tabId : undefined;
  return (
    <div className={mergeClasses(styles.banner, floating && styles.floating)}>
      <span className={styles.label}>Pull request{prs.length > 1 ? 's' : ''}</span>
      {prs.map((pr) => (
        <PullRequestBadge key={pr.url} pr={pr} tabId={tabId} />
      ))}
    </div>
  );
});
PullRequestBanner.displayName = 'PullRequestBanner';
