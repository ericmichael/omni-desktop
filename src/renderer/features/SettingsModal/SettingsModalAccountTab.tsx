import { memo, useCallback, useEffect, useState } from 'react';

import { Button, Card, FormField, SectionLabel, Spinner } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { PlatformCredentials } from '@/shared/types';

type AuthFlowState =
  | { step: 'idle' }
  | { step: 'pending'; userCode: string; verificationUri: string; message: string }
  | { step: 'error'; error: string };

export const SettingsModalAccountTab = memo(() => {
  const [isEnterprise, setIsEnterprise] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<PlatformCredentials | null>(null);
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

  const handleSignOut = useCallback(async () => {
    await emitter.invoke('platform:sign-out');
    setAuth(null);
    setFlow({ step: 'idle' });
  }, []);

  const [copied, setCopied] = useState(false);
  const handleCopyCode = useCallback(() => {
    if (flow.step !== 'pending') return;
    try {
      navigator.clipboard.writeText(flow.userCode);
    } catch {
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

  if (isEnterprise === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (!isEnterprise) {
    return (
      <div className="flex flex-col gap-3">
        <SectionLabel>Account</SectionLabel>
        <Card>
          <p className="text-sm sm:text-xs text-fg-muted">
            This is an open-source build. Enterprise authentication is not available.
          </p>
        </Card>
      </div>
    );
  }

  if (auth) {
    return (
      <div className="flex flex-col gap-3">
        <SectionLabel>Account</SectionLabel>
        <Card>
          <FormField label="Signed in as">
            <span className="text-sm sm:text-xs text-fg-muted">{auth.userEmail ?? 'Unknown'}</span>
          </FormField>
          {auth.userName && (
            <FormField label="Name">
              <span className="text-sm sm:text-xs text-fg-muted">{auth.userName}</span>
            </FormField>
          )}
          {auth.userRole && (
            <FormField label="Role">
              <span className="text-sm sm:text-xs text-fg-muted capitalize">{auth.userRole}</span>
            </FormField>
          )}
          {auth.domains && auth.domains.length > 0 && (
            <FormField label="Domains">
              <span className="text-sm sm:text-xs text-fg-muted">{auth.domains.map((d) => d.name).join(', ')}</span>
            </FormField>
          )}
        </Card>
        <div className="flex justify-end">
          <Button size="sm" variant="destructive" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Account</SectionLabel>
      <Card>
        {flow.step === 'idle' && (
          <>
            <p className="text-sm sm:text-xs text-fg-muted">Sign in with your institutional account to access managed sandboxes and enterprise features.</p>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={handleSignIn}>
                Sign in
              </Button>
            </div>
          </>
        )}

        {flow.step === 'pending' && (
          <>
            <p className="text-sm sm:text-xs text-fg-muted">{flow.message || 'Enter the code below at the verification URL to complete sign-in.'}</p>
            <div className="flex items-center gap-3 p-3 bg-surface rounded-lg border border-surface-border">
              <code className="text-lg font-mono font-bold tracking-widest text-fg flex-1 text-center">
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
              className="text-sm sm:text-xs text-accent-400 hover:text-accent-300 underline truncate"
            >
              {flow.verificationUri}
            </a>
            <div className="flex items-center gap-2 text-sm sm:text-xs text-fg-muted">
              <Spinner />
              <span>Waiting for authentication...</span>
            </div>
          </>
        )}

        {flow.step === 'error' && (
          <>
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 sm:p-2 text-sm sm:text-xs text-red-300">
              {flow.error}
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={handleSignIn}>
                Try again
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
});
SettingsModalAccountTab.displayName = 'SettingsModalAccountTab';
