/**
 * Per-row credential hint shown under a git-remote URL in the add-source flow.
 * Surfaces, at the moment of intent: a matched credential (✓), a missing one
 * for a private-looking host (with an inline "Add token"), or an SSH URL that
 * the runtime silently downgrades to unauthenticated HTTPS. Self-contained.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Regular, LockClosed16Regular, Warning16Regular } from '@fluentui/react-icons';
import { memo, useCallback } from 'react';

import { gitHostFromUrl, isSshRemote, resolveCredentialForUrl } from '@/shared/git-credentials';
import type { GitCredential } from '@/shared/types';

const useStyles = makeStyles({
  credRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
  },
  credOk: { color: tokens.colorPaletteGreenForeground1 },
  credMissing: { color: tokens.colorNeutralForeground2 },
  credWarn: { color: tokens.colorPaletteYellowForeground2 },
  credLink: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    fontWeight: tokens.fontWeightMedium,
  },
});

type CredentialStatusProps = {
  repoUrl: string;
  credentials: GitCredential[];
  onAddToken: (host: string) => void;
};

export const CredentialStatus = memo(({ repoUrl, credentials, onAddToken }: CredentialStatusProps) => {
  const styles = useStyles();
  const url = repoUrl.trim();
  const host = gitHostFromUrl(url);
  const handleAddToken = useCallback(() => {
    if (host) {
      onAddToken(host);
    }
  }, [host, onAddToken]);
  if (!url) {
    return null;
  }
  if (isSshRemote(url)) {
    return (
      <span className={`${styles.credRow} ${styles.credWarn}`}>
        <Warning16Regular />
        SSH URLs aren&apos;t authenticated — paste the HTTPS URL to use a stored token.
      </span>
    );
  }
  if (!host) {
    return null;
  }
  const match = resolveCredentialForUrl(credentials, url);
  if (match) {
    return (
      <span className={`${styles.credRow} ${styles.credOk}`}>
        <CheckmarkCircle16Regular />
        Authenticates with the {host} token.
      </span>
    );
  }
  return (
    <span className={`${styles.credRow} ${styles.credMissing}`}>
      <LockClosed16Regular />
      No credential for {host}.
      <button type="button" className={styles.credLink} onClick={handleAddToken}>
        Add token
      </button>
    </span>
  );
});
CredentialStatus.displayName = 'CredentialStatus';
