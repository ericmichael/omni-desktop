/**
 * Settings → Git. Manages the host-scoped git credentials used to clone and
 * push private repositories. The list is metadata only (host, username, last4)
 * — tokens are write-only and live in the main/server `SecretStore`.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Key20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { Body1, Button, Caption1, ConfirmDialog, IconButton, SectionLabel } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitCredential } from '@/shared/types';

import { ConnectGithubCard } from './ConnectGithubCard';
import { GitCredentialDialog } from './GitCredentialDialog';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  intro: { color: tokens.colorNeutralForeground2 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  rowMain: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  rowHost: { fontWeight: tokens.fontWeightSemibold },
  rowMeta: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  empty: {
    padding: tokens.spacingVerticalXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke2),
  },
  addBtn: { alignSelf: 'flex-start' },
});

export const SettingsModalGitTab = memo(() => {
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const credentials = storeData.gitCredentials ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<GitCredential | null>(null);

  const openAdd = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const clearPendingDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = useCallback(() => {
    if (pendingDelete) {
      void emitter.invoke('git-cred:delete', pendingDelete.id);
    }
  }, [pendingDelete]);

  return (
    <div className={styles.root}>
      <ConnectGithubCard />

      <SectionLabel>Git credentials</SectionLabel>
      <Caption1 className={styles.intro}>
        Tokens used to clone and push private repositories. A credential is matched to a repo by its host, so you add a
        token once per host (e.g. github.com) and every project reuses it.
      </Caption1>

      {credentials.length === 0 ? (
        <div className={styles.empty}>No git credentials yet. Add one to use private remote repos.</div>
      ) : (
        <div className={styles.list}>
          {credentials.map((cred) => (
            <CredentialRow key={cred.id} cred={cred} styles={styles} onDelete={setPendingDelete} />
          ))}
        </div>
      )}

      <Button size="sm" variant="ghost" onClick={openAdd} leftIcon={<Add20Regular />} className={styles.addBtn}>
        Add credential
      </Button>

      <GitCredentialDialog open={dialogOpen} onClose={closeDialog} />
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={clearPendingDelete}
        onConfirm={confirmDelete}
        title="Delete git credential?"
        description={
          pendingDelete
            ? `Remove the stored token for ${pendingDelete.host}? Private repos on that host will stop authenticating.`
            : ''
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
});
SettingsModalGitTab.displayName = 'SettingsModalGitTab';

type CredentialRowProps = {
  cred: GitCredential;
  styles: ReturnType<typeof useStyles>;
  onDelete: (cred: GitCredential) => void;
};

const CredentialRow = memo(({ cred, styles, onDelete }: CredentialRowProps) => {
  const handleDelete = useCallback(() => onDelete(cred), [cred, onDelete]);
  return (
    <div className={styles.row}>
      <Key20Regular className={styles.rowIcon} />
      <div className={styles.rowMain}>
        <Body1 className={styles.rowHost}>{cred.host}</Body1>
        <Caption1 className={styles.rowMeta}>
          {cred.username} · <span className={styles.mono}>••••{cred.last4}</span>
          {cred.label ? ` · ${cred.label}` : ''}
        </Caption1>
      </div>
      <IconButton aria-label={`Delete credential for ${cred.host}`} icon={<Delete20Regular />} onClick={handleDelete} />
    </div>
  );
});
CredentialRow.displayName = 'CredentialRow';
