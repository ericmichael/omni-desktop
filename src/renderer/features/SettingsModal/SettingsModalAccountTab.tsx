import { memo, useCallback, useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardFooter } from '@/renderer/ds/ui/card';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { Spinner } from '@/renderer/ds/ui/spinner';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import { emitter, ipc, isCloudLinked, isElectron } from '@/renderer/services/ipc';
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
    if (flow.step !== 'pending') {
      return;
    }
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
      <div className="flex w-full flex-col gap-5 p-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className={`h-3 ${['w-15', 'w-18', 'w-20'][index % 3]}`} />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!isEnterprise) {
    return (
      <SettingsPane>
        <SettingsSection title="Profile">
          {isElectron || (!isElectron && !isCloudLinked) ? (
            <Card>
              <CardContent>
                <Field>
                  <FieldContent>
                    <FieldLabel>{isElectron ? 'Local profile' : 'Managed profile'}</FieldLabel>
                    <FieldDescription>
                      {isElectron
                        ? 'No account is required. Your projects and settings are stored on this computer.'
                        : 'Your account is managed by this deployment.'}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </CardContent>
            </Card>
          ) : null}
        </SettingsSection>
      </SettingsPane>
    );
  }

  if (auth) {
    return (
      <SettingsPane>
        <SettingsSection title="Profile">
          <Card>
            <CardContent className={settingsCardContentClassName}>
              <Field orientation="horizontal" className="justify-between gap-4">
                <div className="min-w-0">
                  <FieldLabel>Signed in as</FieldLabel>
                </div>
                <span className="text-sm text-muted-foreground sm:text-xs">{auth.userEmail ?? 'Unknown'}</span>
              </Field>
              {auth.userName && (
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Name</FieldLabel>
                  </div>
                  <span className="text-sm text-muted-foreground sm:text-xs">{auth.userName}</span>
                </Field>
              )}
              {auth.userRole && (
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Role</FieldLabel>
                  </div>
                  <span className="text-sm text-muted-foreground capitalize sm:text-xs">{auth.userRole}</span>
                </Field>
              )}
              {auth.domains && auth.domains.length > 0 && (
                <Field orientation="horizontal" className="justify-between gap-4">
                  <div className="min-w-0">
                    <FieldLabel>Domains</FieldLabel>
                  </div>
                  <span className="text-sm text-muted-foreground sm:text-xs">
                    {auth.domains.map((d) => d.name).join(', ')}
                  </span>
                </Field>
              )}
            </CardContent>
            <CardFooter className="justify-end">
              <Button size="sm" variant="outline" onClick={handleSignOut}>
                Sign out
              </Button>
            </CardFooter>
          </Card>
        </SettingsSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SettingsSection title="Profile">
        <Card>
          <CardContent className={settingsCardContentClassName}>
            {flow.step === 'idle' && (
              <>
                <p className="text-sm text-muted-foreground sm:text-xs">
                  Sign in with your institutional account to access managed sandboxes and enterprise features.
                </p>
                <div className="flex justify-end">
                  <Button size="sm" variant="default" onClick={handleSignIn}>
                    Sign in
                  </Button>
                </div>
              </>
            )}

            {flow.step === 'pending' && (
              <>
                <p className="text-sm text-muted-foreground sm:text-xs">
                  {flow.message || 'Enter the code below at the verification URL to complete sign-in.'}
                </p>
                <div className="flex items-center gap-4 p-4 bg-background rounded-xl border border-border">
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
                  className="text-sm text-primary underline overflow-hidden text-ellipsis whitespace-nowrap sm:text-xs"
                >
                  {flow.verificationUri}
                </a>
                <div className="flex items-center gap-2 text-sm text-muted-foreground sm:text-xs">
                  <Spinner />
                  <span>Waiting for authentication...</span>
                </div>
              </>
            )}

            {flow.step === 'error' && (
              <>
                <Alert variant="destructive">
                  <AlertDescription>{flow.error}</AlertDescription>
                </Alert>
                <div className="flex justify-end">
                  <Button size="sm" variant="default" onClick={handleSignIn}>
                    Try again
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalAccountTab.displayName = 'SettingsModalAccountTab';
