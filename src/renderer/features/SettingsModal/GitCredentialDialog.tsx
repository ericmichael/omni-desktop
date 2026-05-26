/**
 * Add/replace a git credential. Shared by the Settings → Git tab and the inline
 * "Add token" affordance in the project source editor (which prefills `host`).
 *
 * The token field is write-only: it's sent up via `git-cred:set` and never read
 * back. Editing an existing host just replaces the token.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Input } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import { defaultUsernameForHost } from '@/shared/git-credentials';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  full: { width: '100%' },
  footer: { gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

type GitCredentialDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Prefill the host (e.g. opened from a source URL). Empty for a blank add. */
  initialHost?: string;
};

export const GitCredentialDialog = memo(({ open, onClose, initialHost = '' }: GitCredentialDialogProps) => {
  const styles = useStyles();
  const [host, setHost] = useState(initialHost);
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Track whether the user has hand-edited the username, so auto-derivation
  // from the host doesn't clobber their choice.
  const [usernameTouched, setUsernameTouched] = useState(false);

  // Reset fields whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setHost(initialHost);
      setUsername(initialHost ? defaultUsernameForHost(initialHost) : '');
      setToken('');
      setLabel('');
      setError(null);
      setUsernameTouched(false);
    }
  }, [open, initialHost]);

  const handleHostChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setHost(next);
      if (!usernameTouched) {
        setUsername(next.trim() ? defaultUsernameForHost(next.trim()) : '');
      }
    },
    [usernameTouched]
  );

  const handleUsernameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUsernameTouched(true);
    setUsername(e.target.value);
  }, []);

  const handleTokenChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setToken(e.target.value);
  }, []);

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
  }, []);

  const handleSave = useCallback(async () => {
    if (!host.trim() || !token) {
      setError('Host and token are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await emitter.invoke('git-cred:set', {
        host: host.trim(),
        username: username.trim() || 'git',
        token,
        label: label.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  }, [host, username, token, label, onClose]);

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>Add git credential</DialogHeader>
        <DialogBody className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>Host</label>
            <Input
              type="text"
              value={host}
              onChange={handleHostChange}
              placeholder="github.com"
              className={styles.full}
            />
            <span className={styles.hint}>Bare host — used to clone and push every repo on it.</span>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Username</label>
            <Input
              type="text"
              value={username}
              onChange={handleUsernameChange}
              placeholder="x-access-token"
              className={styles.full}
            />
            <span className={styles.hint}>
              GitHub tokens use <code>x-access-token</code>; GitLab uses <code>oauth2</code>.
            </span>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Token</label>
            <Input
              type="password"
              value={token}
              onChange={handleTokenChange}
              placeholder="Personal access token"
              className={styles.full}
            />
            <span className={styles.hint}>Stored encrypted on this machine; never shown again.</span>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>
              Label <span className={styles.hint}>(optional)</span>
            </label>
            <Input
              type="text"
              value={label}
              onChange={handleLabelChange}
              placeholder="work GitHub PAT"
              className={styles.full}
            />
          </div>
          {error && (
            <div role="alert" style={{ color: 'var(--colorPaletteRedForeground1)' }}>
              {error}
            </div>
          )}
        </DialogBody>
        <DialogFooter className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} isDisabled={saving || !host.trim() || !token}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
GitCredentialDialog.displayName = 'GitCredentialDialog';
