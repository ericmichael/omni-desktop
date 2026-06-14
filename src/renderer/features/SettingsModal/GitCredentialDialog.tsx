/**
 * Add/replace a git credential. Shared by the Settings → Git tab and the inline
 * "Add token" affordance in the project source editor (which prefills `host`).
 *
 * The token field is write-only: it's sent up via `git-cred:set` and never read
 * back. Editing an existing host just replaces the token.
 *
 * A provider preset selector ("GitHub PAT", "Azure DevOps", "GitLab",
 * "Bitbucket", "Custom") sets host + username and surfaces provider-specific
 * scope guidance + a "Create token" link, so non-OAuth providers (Azure DevOps
 * especially) are discoverable here instead of only in source-picker contexts.
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Input,
  Select,
} from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import { defaultUsernameForHost } from '@/shared/git-credentials';

type PresetId = 'custom' | 'github-pat' | 'azure-devops' | 'gitlab' | 'bitbucket';

type ProviderPreset = {
  id: PresetId;
  label: string;
  host: string;
  username: string;
  scopeHint: string;
  patUrl: string;
};

/**
 * Known providers — selecting one fills host + username and surfaces a "Create
 * token" link so the user doesn't have to remember which scopes to grant or
 * which auth header convention each host uses.
 */
const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'github-pat',
    label: 'GitHub (PAT)',
    host: 'github.com',
    username: 'x-access-token',
    scopeHint:
      'Needs scopes: repo, read:org. Prefer the "Connect GitHub" card above for github.com — this PAT path is for GHES or when OAuth is unavailable.',
    patUrl: 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Omni',
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps (PAT)',
    host: 'dev.azure.com',
    username: 'pat',
    scopeHint: 'Personal access token with Code (Read) at minimum; add Code (Write) for push.',
    patUrl: 'https://dev.azure.com',
  },
  {
    id: 'gitlab',
    label: 'GitLab (PAT)',
    host: 'gitlab.com',
    username: 'oauth2',
    scopeHint: 'Needs scopes: read_repository (clone) and write_repository (push).',
    patUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket (App Password)',
    host: 'bitbucket.org',
    username: 'x-token-auth',
    scopeHint: 'Use an App Password with Repositories: Read, Write.',
    patUrl: 'https://bitbucket.org/account/settings/app-passwords/new',
  },
];

const CUSTOM_PRESET: ProviderPreset = {
  id: 'custom',
  label: 'Custom (other host)',
  host: '',
  username: '',
  scopeHint: 'Any HTTPS-git host. Username defaults to `git` when blank.',
  patUrl: '',
};

const ALL_PRESETS: ProviderPreset[] = [...PROVIDER_PRESETS, CUSTOM_PRESET];

function presetForHost(host: string): ProviderPreset | undefined {
  const h = host.trim().toLowerCase();
  if (!h) {
    return undefined;
  }
  return PROVIDER_PRESETS.find((p) => p.host === h);
}

function presetById(id: PresetId): ProviderPreset {
  return ALL_PRESETS.find((p) => p.id === id) ?? CUSTOM_PRESET;
}

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
  const [preset, setPreset] = useState<PresetId>('custom');
  const [host, setHost] = useState(initialHost);
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Track whether the user has hand-edited the username, so auto-derivation
  // from the host doesn't clobber their choice.
  const [usernameTouched, setUsernameTouched] = useState(false);

  // Reset fields whenever the dialog (re)opens. If an `initialHost` matches a
  // known provider, auto-select its preset so the user sees provider-specific
  // guidance immediately (e.g. opened from the Azure source picker).
  useEffect(() => {
    if (open) {
      const matched = presetForHost(initialHost);
      setPreset(matched?.id ?? 'custom');
      setHost(initialHost);
      // Prefer the preset's canonical username when matched, falling back to
      // host-based derivation for unknown hosts.
      setUsername(matched ? matched.username : initialHost ? defaultUsernameForHost(initialHost) : '');
      setToken('');
      setLabel('');
      setError(null);
      setUsernameTouched(false);
    }
  }, [open, initialHost]);

  const handlePresetChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value as PresetId;
    setPreset(id);
    const p = presetById(id);
    if (id !== 'custom') {
      setHost(p.host);
      setUsername(p.username);
      setUsernameTouched(false);
    }
  }, []);

  const handleHostChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setHost(next);
      if (!usernameTouched) {
        setUsername(next.trim() ? defaultUsernameForHost(next.trim()) : '');
      }
      // Re-derive preset so the hint + scope guidance follow the typed host.
      const matched = presetForHost(next);
      setPreset(matched?.id ?? 'custom');
    },
    [usernameTouched]
  );

  const openPatUrl = useCallback(() => {
    const url = presetById(preset).patUrl;
    if (url) {
      void emitter.invoke('util:open-external', url);
    }
  }, [preset]);

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

  const activePreset = presetById(preset);

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>Add git credential</DialogHeader>
        <DialogBody className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>Provider</label>
            <Select value={preset} onChange={handlePresetChange} className={styles.full}>
              {ALL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <span className={styles.hint}>{activePreset.scopeHint}</span>
          </div>
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
              Most hosts use a fixed username (GitHub: <code>x-access-token</code>, GitLab: <code>oauth2</code>) — the
              token in the next field is what authenticates.
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
            {activePreset.patUrl && (
              <Button size="sm" variant="ghost" onClick={openPatUrl} leftIcon={<Open16Regular />}>
                Create token on {activePreset.host}
              </Button>
            )}
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
