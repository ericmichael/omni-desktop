import { memo, useCallback, useEffect, useState } from 'react';

import { StartupError } from '@/renderer/common/StartupError';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { PlatformCredentials } from '@/shared/types';

type AuthFlowState =
  | { step: 'idle' }
  | { step: 'pending'; userCode: string; verificationUri: string; message: string }
  | { step: 'error'; error: string };

/**
 * Auth gate for enterprise builds. Blocks access to the app until the user signs in.
 * In open-source builds (no platform URL), renders children immediately.
 */
export const AuthGate = memo(({ children }: { children: React.ReactNode }) => {
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<PlatformCredentials | null | undefined>(undefined);
  const [flow, setFlow] = useState<AuthFlowState>({ step: 'idle' });
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let authChanged = false;
    const stop = ipc.on('platform:auth-changed', (credentials) => {
      authChanged = true;
      setAuth(credentials);
      setFlow({ step: 'idle' });
    });
    const failed = (error: unknown) => {
      if (live) {
        setBootstrapError(error instanceof Error ? error.message : 'Unable to connect. Please reload.');
      }
    };
    void emitter
      .invoke('platform:is-enterprise')
      .then((value) => {
        if (live) {
          setIsEnterprise(value);
        }
      })
      .catch(failed);
    void emitter
      .invoke('platform:get-auth')
      .then((value) => {
        // A sign-in/out event is newer than this bootstrap snapshot.
        if (live && !authChanged) {
          setAuth(value);
        }
      })
      .catch((error) => {
        if (!authChanged) {
          failed(error);
        }
      });
    return () => {
      live = false;
      stop();
    };
  }, []);

  const handleSignIn = useCallback(async () => {
    try {
      const result = await emitter.invoke('platform:sign-in');
      setFlow({
        step: 'pending',
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        message: result.message,
      });
    } catch (err) {
      setFlow({ step: 'error', error: err instanceof Error ? err.message : 'Sign-in failed' });
    }
  }, []);

  const [copied, setCopied] = useState(false);
  const handleCopyCode = useCallback(() => {
    if (flow.step !== 'pending') {
      return;
    }
    try {
      // Secure context (HTTPS / localhost)
      navigator.clipboard.writeText(flow.userCode);
    } catch {
      // Fallback for plain HTTP
      const ta = document.createElement('textarea');
      ta.value = flow.userCode;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [flow]);

  if (bootstrapError) {
    return <StartupError title="Unable to check sign-in status" error={bootstrapError} />;
  }

  // Still loading
  if (isEnterprise === null || auth === undefined) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <Spinner />
      </div>
    );
  }

  // Not enterprise — pass through
  if (!isEnterprise) {
    return <>{children}</>;
  }

  // Signed in — pass through
  if (auth) {
    return <>{children}</>;
  }

  // Enterprise build, not signed in — show gate
  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className="w-full max-w-96 flex flex-col gap-8 p-8">
        <div className="text-center">
          <h1 className="text-base font-semibold text-foreground">Sign in to Omni Code</h1>
          <p className="text-xs text-muted-foreground mt-2">Sign in with your institutional account to continue.</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-6 flex flex-col gap-5">
          {flow.step === 'idle' && (
            <Button variant="default" onClick={handleSignIn} className="w-full">
              Sign in with your institution
            </Button>
          )}

          {flow.step === 'pending' && (
            <>
              <p className="text-xs text-muted-foreground text-center">
                {flow.message || 'Enter this code at the verification URL:'}
              </p>
              <div className="flex items-center gap-4 p-4 bg-background rounded-lg border border-border">
                <code className="text-xl font-mono font-bold tracking-widest text-foreground flex-1 text-center">
                  {flow.userCode}
                </code>
                <Button size="sm" variant="ghost" onClick={handleCopyCode}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline text-center block"
              >
                {flow.verificationUri}
              </a>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Spinner />
                <span>Waiting for authentication...</span>
              </div>
            </>
          )}

          {flow.step === 'error' && (
            <>
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-center text-xs text-destructive">
                {flow.error}
              </div>
              <Button variant="default" onClick={handleSignIn} className="w-full">
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
AuthGate.displayName = 'AuthGate';
