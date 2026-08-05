/**
 * Per-row credential hint shown under a git-remote URL in the add-source flow.
 * Surfaces, at the moment of intent: a matched credential (✓), a missing one
 * for a private-looking host (with an inline "Add token"), or an SSH URL that
 * the runtime silently downgrades to unauthenticated HTTPS. Self-contained.
 */
import { CircleCheck, Lock, TriangleAlert } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { gitHostFromUrl, isSshRemote, resolveCredentialForUrl } from '@/shared/git-credentials';
import type { GitCredential } from '@/shared/types';

type CredentialStatusProps = {
  repoUrl: string;
  credentials: GitCredential[];
  onAddToken: (host: string) => void;
};

export const CredentialStatus = memo(({ repoUrl, credentials, onAddToken }: CredentialStatusProps) => {
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
      <span className={`${'flex items-center gap-1 text-xs'} ${'text-warning'}`}>
        <TriangleAlert />
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
      <span className={`${'flex items-center gap-1 text-xs'} ${'text-success'}`}>
        <CircleCheck />
        Authenticates with the {host} token.
      </span>
    );
  }
  return (
    <span className={`${'flex items-center gap-1 text-xs'} ${'text-muted-foreground'}`}>
      <Lock />
      No credential for {host}.
      <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={handleAddToken}>
        Add token
      </Button>
    </span>
  );
});
CredentialStatus.displayName = 'CredentialStatus';
