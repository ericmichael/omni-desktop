import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button, Spinner } from '@/renderer/ds';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { PlatformCredentials } from '@/shared/types';

const useStyles = makeStyles({
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' },
  gate: { width: '100%', maxWidth: '384px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL, padding: '32px' },
  header: { textAlign: 'center' },
  title: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, marginTop: tokens.spacingVerticalS },
  card: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    padding: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  fullWidthBtn: { width: '100%' },
  pendingHint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, textAlign: 'center' },
  codeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  codeText: {
    fontSize: '20px',
    fontFamily: 'monospace',
    fontWeight: tokens.fontWeightBold,
    letterSpacing: '0.1em',
    color: tokens.colorNeutralForeground1,
    flex: '1 1 0',
    textAlign: 'center',
  },
  verifyLink: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    textDecoration: 'underline',
    textAlign: 'center',
    display: 'block',
  },
  waitingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  errorBox: {
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', 'rgba(239, 68, 68, 0.3)'),
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    padding: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase200,
    color: '#fca5a5',
    textAlign: 'center',
  },
});

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

  const styles = useStyles();

  // Still loading
  if (isEnterprise === null || auth === undefined) {
    return (
      <div className={styles.center}>
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
    <div className={styles.center}>
      <div className={styles.gate}>
        <div className={styles.header}>
          <h1 className={styles.title}>Sign in to Omni Code</h1>
          <p className={styles.subtitle}>
            Sign in with your institutional account to continue.
          </p>
        </div>

        <div className={styles.card}>
          {flow.step === 'idle' && (
            <Button variant="primary" onClick={handleSignIn} className={styles.fullWidthBtn}>
              Sign in with your institution
            </Button>
          )}

          {flow.step === 'pending' && (
            <>
              <p className={styles.pendingHint}>
                {flow.message || 'Enter this code at the verification URL:'}
              </p>
              <div className={styles.codeRow}>
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
                className={styles.verifyLink}
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
              <div className={styles.errorBox}>
                {flow.error}
              </div>
              <Button variant="primary" onClick={handleSignIn} className={styles.fullWidthBtn}>
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
