/**
 * Edit an existing project source in place. The source *kind* is fixed
 * (local stays local, git-remote stays git-remote — change kind by remove +
 * re-add); only its editable fields change:
 *
 *   - local      — workspace directory + mount name
 *   - git-remote — repo URL + default branch + mount name
 *
 * Writes back through the same `updateProject({ sources })` path
 * `AddSourceDialog` uses, replacing the matching source **by id** so the
 * per-source ticket / PR state stays attached. Reached from the sidebar's
 * Sources ⋯ menu, alongside Remove.
 */
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Input } from '@/renderer/ds/ui/input';
import { GitCredentialDialog } from '@/renderer/features/SettingsModal/GitCredentialDialog';
import { DirectoryBrowserDialog } from '@/renderer/features/Tickets/DirectoryBrowserDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import { duplicateSourceIdentityMessage, sourceIdentityKey } from '@/shared/project-source';
import type { Project, ProjectSource } from '@/shared/types';

import { CredentialStatus } from './CredentialStatus';
import { deriveMountName, emptyLocalDraft } from './source-draft';
import { projectsApi } from './state';

type EditSourceDialogProps = {
  open: boolean;
  onClose: () => void;
  project: Project;
  source: ProjectSource;
};

export const EditSourceDialog = memo(({ open, onClose, project, source }: EditSourceDialogProps) => {
  const storeData = useStore(persistedStoreApi.$atom);
  const credentials = storeData.gitCredentials ?? [];

  const isLocal = source.kind === 'local';

  const [mount, setMount] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [browseDir, setBrowseDir] = useState(false);
  const [addTokenHost, setAddTokenHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hydrate fields from the source whenever the dialog opens (or the edited
  // source changes underneath it).
  useEffect(() => {
    if (open) {
      setMount(source.mountName);
      setWorkspaceDir(source.kind === 'local' ? source.workspaceDir : '');
      setRepoUrl(source.kind === 'git-remote' ? source.repoUrl : '');
      setBranch(source.kind === 'git-remote' ? (source.defaultBranch ?? '') : '');
      setReadOnly(source.readOnly ?? false);
      setError(null);
    }
  }, [open, source]);

  const openBrowse = useCallback(() => setBrowseDir(true), []);
  const closeBrowse = useCallback(() => setBrowseDir(false), []);
  const handleDirSelected = useCallback((dir: string) => {
    setWorkspaceDir(dir);
    setMount((m) => m || deriveMountName({ ...emptyLocalDraft(), workspaceDir: dir }));
    setBrowseDir(false);
  }, []);
  const handleMount = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setMount(e.target.value), []);
  const handleRepoUrl = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value), []);
  const handleBranch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value), []);
  const closeAddToken = useCallback(() => setAddTokenHost(null), []);

  const handleSave = useCallback(async () => {
    const path = isLocal ? workspaceDir.trim() : repoUrl.trim();
    if (!path) {
      setError(isLocal ? 'Choose a directory.' : 'Enter a repository URL.');
      return;
    }
    const draftLike = isLocal
      ? { ...emptyLocalDraft(), kind: 'local' as const, workspaceDir: path }
      : { ...emptyLocalDraft(), kind: 'git-remote' as const, repoUrl: path };
    const mountName = (mount.trim() || deriveMountName(draftLike) || 'source').trim();

    // Mount must stay unique within the project — ignore the row being edited.
    const taken = new Set(project.sources.filter((s) => s.id !== source.id).map((s) => s.mountName));
    if (taken.has(mountName)) {
      setError(`This project already has a source mounted at "${mountName}".`);
      return;
    }

    const trimmedBranch = branch.trim();
    const next: ProjectSource =
      source.kind === 'local'
        ? {
            id: source.id,
            mountName,
            kind: 'local',
            workspaceDir: path,
            ...(source.gitDetected !== undefined ? { gitDetected: source.gitDetected } : {}),
            ...(readOnly ? { readOnly: true } : {}),
          }
        : {
            id: source.id,
            mountName,
            kind: 'git-remote',
            repoUrl: path,
            ...(trimmedBranch ? { defaultBranch: trimmedBranch } : {}),
            ...(readOnly ? { readOnly: true } : {}),
          };

    const existingIdentities = new Set(project.sources.filter((s) => s.id !== source.id).map(sourceIdentityKey));
    if (existingIdentities.has(sourceIdentityKey(next))) {
      setError(duplicateSourceIdentityMessage(next));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await projectsApi.updateProject(project.id, {
        sources: project.sources.map((s) => (s.id === source.id ? next : s)),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save source');
    } finally {
      setSaving(false);
    }
  }, [isLocal, workspaceDir, repoUrl, mount, branch, readOnly, project.id, project.sources, source, onClose]);

  const mountPlaceholder = deriveMountName(
    isLocal ? { ...emptyLocalDraft(), workspaceDir } : { ...emptyLocalDraft(), kind: 'git-remote', repoUrl }
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit source</DialogTitle>
          </DialogHeader>
          <div className={cn('min-h-0 overflow-y-auto', 'flex flex-col gap-5')}>
            {isLocal ? (
              <div className="flex flex-col gap-1">
                <label className="text-sm text-foreground">Workspace directory</label>
                <div className="flex items-center gap-2">
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-border bg-background px-4 py-2 text-sm text-muted-foreground">
                    {workspaceDir || 'No directory selected'}
                  </span>
                  <Button size="sm" variant="ghost" onClick={openBrowse}>
                    Browse
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-sm text-foreground">Repo URL</label>
                <Input
                  type="text"
                  value={repoUrl}
                  onChange={handleRepoUrl}
                  placeholder="https://github.com/owner/name"
                  className="w-full"
                />

                <CredentialStatus repoUrl={repoUrl} credentials={credentials} onAddToken={setAddTokenHost} />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-sm text-foreground">
                Mount name <span className="text-xs text-muted-foreground">(folder under /workspace/)</span>
              </label>
              <Input
                type="text"
                value={mount}
                onChange={handleMount}
                placeholder={mountPlaceholder || 'e.g. launcher'}
                className="w-full"
              />
            </div>

            {!isLocal && (
              <div className="flex flex-col gap-1">
                <label className="text-sm text-foreground">
                  Default branch <span className="text-xs text-muted-foreground">(optional)</span>
                </label>
                <Input
                  type="text"
                  value={branch}
                  onChange={handleBranch}
                  placeholder="Leave blank for the repo's default branch"
                  className="w-full"
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="inline-flex items-center gap-2 text-sm">
                <Checkbox checked={readOnly} onCheckedChange={(checked) => setReadOnly(checked === true)} />
                Read-only source
              </label>
              <span className="text-xs text-muted-foreground">
                Omni’s file editor can inspect this source but cannot change its files.
              </span>
            </div>

            {error && (
              <div role="alert" className="text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DirectoryBrowserDialog
        open={browseDir}
        onClose={closeBrowse}
        onSelect={handleDirSelected}
        initialPath={workspaceDir || undefined}
      />

      <GitCredentialDialog open={addTokenHost !== null} onClose={closeAddToken} initialHost={addTokenHost ?? ''} />
    </>
  );
});
EditSourceDialog.displayName = 'EditSourceDialog';
