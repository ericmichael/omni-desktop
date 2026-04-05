import { memo, useCallback, useEffect, useState } from 'react';

import { Button, Spinner } from '@/renderer/ds';
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

  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
    emitter.invoke('platform:get-auth').then(setAuth);
  }, []);

  useEffect(() => {
    return ipc.on('platform:auth-changed', (credentials) => {
      setAuth(credentials);
      if (credentials) {
        setFlow({ step: 'idle' });
      }
    });
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
    if (flow.step !== 'pending') return;
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
      <div className="w-full max-w-sm flex flex-col gap-6 p-8">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-fg">Sign in to Omni Code</h1>
          <p className="text-xs text-fg-muted mt-2">
            Sign in with your institutional account to continue.
          </p>
        </div>

        <div className="bg-surface-raised/50 rounded-lg border border-surface-border/50 p-5 flex flex-col gap-4">
          {flow.step === 'idle' && (
            <Button variant="primary" onClick={handleSignIn} className="w-full">
              Sign in with your institution
            </Button>
          )}

          {flow.step === 'pending' && (
            <>
              <p className="text-xs text-fg-muted text-center">
                {flow.message || 'Enter this code at the verification URL:'}
              </p>
              <div className="flex items-center gap-3 p-3 bg-surface rounded-md border border-surface-border">
                <code className="text-xl font-mono font-bold tracking-widest text-fg flex-1 text-center">
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
                className="text-xs text-accent-400 hover:text-accent-300 underline text-center block"
              >
                {flow.verificationUri}
              </a>
              <div className="flex items-center justify-center gap-2 text-xs text-fg-muted">
                <Spinner />
                <span>Waiting for authentication...</span>
              </div>
            </>
          )}

          {flow.step === 'error' && (
            <>
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300 text-center">
                {flow.error}
              </div>
              <Button variant="primary" onClick={handleSignIn} className="w-full">
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
