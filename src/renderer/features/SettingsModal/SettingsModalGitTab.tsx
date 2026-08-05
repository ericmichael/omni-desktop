/**
 * Settings → Git. Manages the host-scoped git credentials used to clone and
 * push private repositories. The list is metadata only (host, username, last4)
 * — tokens are write-only and live in the main/server `SecretStore`.
 */
import { useStore } from '@nanostores/react';
import { Key, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Button } from '@/renderer/ds/ui/button';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitCredential } from '@/shared/types';

import { ConnectGithubCard } from './ConnectGithubCard';
import { GitCredentialDialog } from './GitCredentialDialog';
import { SettingsPane, SettingsSection } from './SettingsLayout';

export const SettingsModalGitTab = memo(() => {
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
    <SettingsPane>
      <SettingsSection title="GitHub">
        <ConnectGithubCard />
      </SettingsSection>

      <SettingsSection
        title="Git credentials"
        description="Tokens used to clone and push private repositories. Credentials are matched to repositories by host."
      >
        {credentials.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground rounded-lg border border-dashed border-border">
            No git credentials yet. Add one to use private remote repos.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {credentials.map((cred) => (
              <CredentialRow key={cred.id} cred={cred} onDelete={setPendingDelete} />
            ))}
          </div>
        )}

        <Button size="sm" variant="ghost" onClick={openAdd} className="self-start">
          <Plus />
          Add credential
        </Button>
      </SettingsSection>

      <GitCredentialDialog open={dialogOpen} onClose={closeDialog} />
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && clearPendingDelete()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete git credential?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `Remove the stored token for ${pendingDelete.host}? Private repos on that host will stop authenticating.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPane>
  );
});
SettingsModalGitTab.displayName = 'SettingsModalGitTab';

type CredentialRowProps = {
  cred: GitCredential;
  onDelete: (cred: GitCredential) => void;
};

const CredentialRow = memo(({ cred, onDelete }: CredentialRowProps) => {
  const handleDelete = useCallback(() => onDelete(cred), [cred, onDelete]);
  return (
    <div className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card">
      <Key className="text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className={cn('text-sm', 'font-semibold')}>{cred.host}</span>
        <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
          {cred.username} · <span className="font-mono">••••{cred.last4}</span>
          {cred.label ? ` · ${cred.label}` : ''}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Delete credential for ${cred.host}`}
        onClick={handleDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
});
CredentialRow.displayName = 'CredentialRow';
