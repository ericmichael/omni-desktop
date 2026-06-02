import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
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
});

/**
 * Clickable "PR #N" badge that opens the pull request in the built-in browser
 * (same bridge the agent's ``browser_open`` tool uses). Shared by the ticket PR
 * overview and the per-source Files Changed view (ticket + code-tab scopes).
 */
export const PullRequestBadge = memo(({ pr, tabId }: { pr: ContainerPullRequest; tabId?: string }) => {
  const styles = useStyles();
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
      className={styles.prBadge}
      title={pr.url}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <Open16Regular />
      PR #{pr.number}
    </span>
  );
});
PullRequestBadge.displayName = 'PullRequestBadge';
