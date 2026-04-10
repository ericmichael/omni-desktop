import { memo, useCallback, useEffect, useState } from 'react';

import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { Button, Card, FormField, FormSkeleton, MessageBar, MessageBarBody, SectionLabel, Spinner } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { PlatformCredentials } from '@/shared/types';

type AuthFlowState =
  | { step: 'idle' }
  | { step: 'pending'; userCode: string; verificationUri: string; message: string }
  | { step: 'error'; error: string };

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  text: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  textCapitalize: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    textTransform: 'capitalize',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  flexEnd: { display: 'flex', justifyContent: 'flex-end' },
  codeBox: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  codeText: {
    fontSize: tokens.fontSizeBase500,
    fontFamily: 'monospace',
    fontWeight: tokens.fontWeightBold,
    letterSpacing: '0.1em',
    color: tokens.colorNeutralForeground1,
    flex: '1 1 0',
    textAlign: 'center',
  },
  link: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorBrandForeground1,
    textDecorationLine: 'underline',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  waitingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalAccountTab = memo(() => {
  const styles = useStyles();
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
    return <FormSkeleton fields={3} />;
  }

  if (!isEnterprise) {
    return (
      <div className={styles.root}>
        <SectionLabel>Account</SectionLabel>
        <Card>
          <p className={styles.text}>
            This is an open-source build. Enterprise authentication is not available.
          </p>
        </Card>
      </div>
    );
  }

  if (auth) {
    return (
      <div className={styles.root}>
        <SectionLabel>Account</SectionLabel>
        <Card>
          <FormField label="Signed in as">
            <span className={styles.text}>{auth.userEmail ?? 'Unknown'}</span>
          </FormField>
          {auth.userName && (
            <FormField label="Name">
              <span className={styles.text}>{auth.userName}</span>
            </FormField>
          )}
          {auth.userRole && (
            <FormField label="Role">
              <span className={styles.textCapitalize}>{auth.userRole}</span>
            </FormField>
          )}
          {auth.domains && auth.domains.length > 0 && (
            <FormField label="Domains">
              <span className={styles.text}>{auth.domains.map((d) => d.name).join(', ')}</span>
            </FormField>
          )}
        </Card>
        <div className={styles.flexEnd}>
          <Button size="sm" variant="destructive" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <SectionLabel>Account</SectionLabel>
      <Card>
        {flow.step === 'idle' && (
          <>
            <p className={styles.text}>Sign in with your institutional account to access managed sandboxes and enterprise features.</p>
            <div className={styles.flexEnd}>
              <Button size="sm" variant="primary" onClick={handleSignIn}>
                Sign in
              </Button>
            </div>
          </>
        )}

        {flow.step === 'pending' && (
          <>
            <p className={styles.text}>{flow.message || 'Enter the code below at the verification URL to complete sign-in.'}</p>
            <div className={styles.codeBox}>
              <code className={styles.codeText}>
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
              className={styles.link}
            >
              {flow.verificationUri}
            </a>
            <div className={styles.waitingRow}>
              <Spinner />
              <span>Waiting for authentication...</span>
            </div>
          </>
        )}

        {flow.step === 'error' && (
          <>
            <MessageBar intent="error"><MessageBarBody>{flow.error}</MessageBarBody></MessageBar>
            <div className={styles.flexEnd}>
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
