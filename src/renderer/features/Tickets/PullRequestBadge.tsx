import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Regular, Open16Regular } from '@fluentui/react-icons';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { memo, useCallback } from 'react';

import type { ContainerPullRequest } from '@/shared/types';

import { requestPreviewOpen } from './preview-bridge';

const useStyles = makeStyles({
  prBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    ...shorthands.border('1px', 'solid', tokens.colorPalettePurpleBorderActive),
    backgroundColor: tokens.colorPalettePurpleBackground2,
    color: tokens.colorPalettePurpleForeground2,
    borderRadius: tokens.borderRadiusCircular,
    padding: `2px ${tokens.spacingHorizontalS}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    cursor: 'pointer',
    ':hover': { textDecoration: 'underline' },
  },
  prBadgeMerged: {
    ...shorthands.border('1px', 'solid', tokens.colorPaletteGreenBorderActive),
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
  },
});

/**
 * Clickable "PR #N" badge that opens the pull request in the built-in browser
 * (same bridge the agent's ``browser_open`` tool uses). Shared by the Changes
 * panel and the per-source Files Changed view (ticket + code-tab scopes).
 * Merged PRs render as a green ✓ "Merged #N" badge instead of vanishing.
 */
export const PullRequestBadge = memo(({ pr, tabId }: { pr: ContainerPullRequest; tabId?: string }) => {
  const styles = useStyles();
  const merged = pr.state === 'MERGED';
  const numberLabel = merged ? `Merged #${pr.number}` : `PR #${pr.number}`;
  const label = pr.sourceMountName ? `${pr.sourceMountName} · ${numberLabel}` : numberLabel;
  const title = [pr.title, pr.sourceMountName, pr.branch, pr.url].filter(Boolean).join(' · ');
  const handleOpen = useCallback(
    () => (tabId === undefined ? requestPreviewOpen(pr.url) : requestPreviewOpen(pr.url, tabId)),
    [pr.url, tabId]
  );
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleOpen();
      }
    },
    [handleOpen]
  );
  return (
    <span
      role="button"
      tabIndex={0}
      className={merged ? `${styles.prBadge} ${styles.prBadgeMerged}` : styles.prBadge}
      title={title || pr.url}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      {merged ? <CheckmarkCircle16Regular /> : <Open16Regular />}
      {label}
    </span>
  );
});
PullRequestBadge.displayName = 'PullRequestBadge';
