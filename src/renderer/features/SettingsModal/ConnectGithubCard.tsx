/**
 * "Connect GitHub" card for Settings → Git. Linking runs the OAuth device flow
 * in the main process; this card displays the user code (pushed via the
 * `github:device-code` event) while it polls, then shows the connected account.
 *
 * Connecting also populates the `github.com` git credential, so once linked the
 * credential list shows it and private clone/push work — no manual PAT needed.
 */
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Avatar, AvatarFallback, AvatarImage } from '@/renderer/ds/ui/avatar';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GithubDeviceCode } from '@/shared/types';

export const ConnectGithubCard = memo(() => {
  const storeData = useStore(persistedStoreApi.$atom);
  const account = storeData.githubAccount;

  const [connecting, setConnecting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<GithubDeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The main process emits the user code mid-flow; show it while we poll.
  useEffect(() => ipc.on('github:device-code', setDeviceCode), []);

  const onConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    setDeviceCode(null);
    try {
      await emitter.invoke('github:link');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'GitHub linking failed');
    } finally {
      setConnecting(false);
      setDeviceCode(null);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    setError(null);
    try {
      await emitter.invoke('github:unlink');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    }
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          {account && (
            <Avatar className="size-9">
              <AvatarImage src={account.avatarUrl} alt="" />
              <AvatarFallback>{account.login.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
          )}
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-sm">
              {account ? `Connected as @${account.login}` : 'Connect your GitHub account'}
            </span>
            <span className={cn('text-xs text-muted-foreground', error ? 'text-destructive' : 'text-muted-foreground')}>
              {error ??
                (account
                  ? `${account.host} · clone/push private repos and pick from your repositories`
                  : 'Authenticate once to clone private repos and pick sources from a list — no token to paste.')}
            </span>
          </div>
          {account ? (
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect GitHub'}
            </Button>
          )}
        </div>

        {connecting && deviceCode && (
          <div className="flex flex-col gap-0.5 p-2 rounded-lg bg-background border border-border">
            <span className="text-xs text-muted-foreground">
              Open{' '}
              <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer">
                {deviceCode.verificationUri}
              </a>{' '}
              and enter this code:
            </span>
            <span className="font-mono text-xl font-semibold tracking-widest">{deviceCode.userCode}</span>
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-xs text-muted-foreground">Waiting for authorization…</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
ConnectGithubCard.displayName = 'ConnectGithubCard';
