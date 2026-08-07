/**
 * Add a single source to an existing project, organized by **provider** rather
 * than by local-vs-remote:
 *
 *   - GitHub — the linked account's repos, searched inline (pick-to-add).
 *   - Local folder — a directory on this machine.
 *   - Git URL — any remote by URL (incl. Azure DevOps today), with the
 *     credential ✓/🔒 hint.
 *
 * New providers (e.g. a first-class Azure DevOps picker) slot in as another
 * option + body branch. Reached from the sidebar's Sources branch and the
 * project page's ⋯ menu, so source management lives where sources are shown.
 */
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { GitCredentialDialog } from '@/renderer/features/SettingsModal/GitCredentialDialog';
import { DirectoryBrowserDialog } from '@/renderer/features/Tickets/DirectoryBrowserDialog';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { duplicateSourceIdentityMessage, sourceIdentityKey } from '@/shared/project-source';
import type { Project, ProjectSource, RemoteRepo } from '@/shared/types';

import { CredentialStatus } from './CredentialStatus';
import { RepoPicker, type RepoScope } from './RepoPicker';
import { deriveMountName, draftsToSources, emptyLocalDraft, type SourceDraft } from './source-draft';
import { projectsApi } from './state';

type Provider = 'github' | 'azure' | 'local' | 'url';

const AZURE_HOST = 'dev.azure.com';

/** Make a mount name unique within the project by suffixing -2, -3, … */
function uniqueMount(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) {
    n++;
  }
  return `${base}-${n}`;
}

type AddSourceDialogProps = {
  open: boolean;
  onClose: () => void;
  project: Project;
};

export const AddSourceDialog = memo(({ open, onClose, project }: AddSourceDialogProps) => {
  const storeData = useStore(persistedStoreApi.$atom);
  const credentials = storeData.gitCredentials ?? [];
  const githubLinked = Boolean(storeData.githubAccount);
  const azureLinked = credentials.some((c) => c.host === AZURE_HOST);

  const [provider, setProvider] = useState<Provider>('local');
  // Local provider
  const [localDir, setLocalDir] = useState('');
  const [localMount, setLocalMount] = useState('');
  const [browseDir, setBrowseDir] = useState(false);
  // Git URL provider
  const [repoUrl, setRepoUrl] = useState('');
  const [urlMount, setUrlMount] = useState('');
  const [branch, setBranch] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [addTokenHost, setAddTokenHost] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setProvider(githubLinked ? 'github' : 'local');
      setLocalDir('');
      setLocalMount('');
      setRepoUrl('');
      setUrlMount('');
      setBranch('');
      setReadOnly(false);
      setError(null);
    }
  }, [open, githubLinked]);

  /** Validate + append a built draft. `autoSuffix` keeps the GitHub fast-path
   *  from dead-ending on a mount-name clash (no editable field there). */
  const addDraft = useCallback(
    async (draft: SourceDraft, autoSuffix: boolean): Promise<void> => {
      const conv = draftsToSources([draft]);
      if (!conv.ok) {
        setError(conv.error);
        return;
      }
      const built = conv.sources[0];
      if (!built) {
        setError(draft.kind === 'local' ? 'Choose a directory.' : 'Enter a repository URL.');
        return;
      }
      const taken = new Set(project.sources.map((s) => s.mountName));
      const existingIdentities = new Set(project.sources.map(sourceIdentityKey));
      if (existingIdentities.has(sourceIdentityKey(built))) {
        setError(duplicateSourceIdentityMessage(built));
        return;
      }
      let next: ProjectSource = built;
      if (taken.has(built.mountName)) {
        if (!autoSuffix) {
          setError(`This project already has a source mounted at "${built.mountName}".`);
          return;
        }
        next = { ...built, mountName: uniqueMount(built.mountName, taken) };
      }
      setSaving(true);
      setError(null);
      try {
        await projectsApi.updateProject(project.id, { sources: [...project.sources, next] });
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to add source');
      } finally {
        setSaving(false);
      }
    },
    [project.id, project.sources, onClose]
  );

  const handleProvider = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setProvider(e.target.value as Provider);
    setError(null);
  }, []);

  // GitHub / Azure: pick-to-add (mount derived from the repo, auto-suffixed on clash).
  const handleRepoPick = useCallback(
    (repo: RemoteRepo) => {
      const draft: SourceDraft = {
        ...emptyLocalDraft(),
        kind: 'git-remote',
        repoUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        readOnly,
      };
      void addDraft({ ...draft, mountName: deriveMountName(draft) }, true);
    },
    [addDraft, readOnly]
  );

  // Provider adapters for the generic RepoPicker.
  const githubLoadScopes = useCallback(
    (): Promise<RepoScope[]> =>
      emitter
        .invoke('github:list-owners')
        .then((owners) =>
          owners.map((o) => ({ id: o.login, label: o.kind === 'user' ? `${o.login} (you)` : o.login, kind: o.kind }))
        ),
    []
  );
  const githubSearch = useCallback(
    (scope: RepoScope, query: string): Promise<RemoteRepo[]> =>
      emitter.invoke('github:search-repos', { owner: scope.id, kind: scope.kind ?? 'user', query }),
    []
  );
  const githubEmptyHint = useCallback(
    (scope: RepoScope | undefined): string =>
      scope?.kind === 'org'
        ? `No repositories found — if ${scope.label} enforces SSO, you may need to authorize this app for the org in your GitHub settings.`
        : 'No repositories found.',
    []
  );
  const azureSearch = useCallback(
    (scope: RepoScope, query: string): Promise<RemoteRepo[]> =>
      emitter.invoke('azure:list-repos', { org: scope.id, query }),
    []
  );
  const openAzureToken = useCallback(() => setAddTokenHost(AZURE_HOST), []);

  // Local
  const openBrowse = useCallback(() => setBrowseDir(true), []);
  const closeBrowse = useCallback(() => setBrowseDir(false), []);
  const handleDirSelected = useCallback((dir: string) => {
    setLocalDir(dir);
    setLocalMount((m) => m || deriveMountName({ ...emptyLocalDraft(), workspaceDir: dir }));
    setBrowseDir(false);
  }, []);
  const handleLocalMount = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setLocalMount(e.target.value), []);
  const handleAddLocal = useCallback(() => {
    void addDraft(
      { ...emptyLocalDraft(), kind: 'local', workspaceDir: localDir, mountName: localMount, readOnly },
      false
    );
  }, [addDraft, localDir, localMount, readOnly]);

  // Git URL
  const handleRepoUrl = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value), []);
  const handleUrlMount = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setUrlMount(e.target.value), []);
  const handleBranch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value), []);
  const closeAddToken = useCallback(() => setAddTokenHost(null), []);
  const handleAddUrl = useCallback(() => {
    void addDraft(
      { ...emptyLocalDraft(), kind: 'git-remote', repoUrl, defaultBranch: branch, mountName: urlMount, readOnly },
      false
    );
  }, [addDraft, repoUrl, branch, urlMount, readOnly]);

  const localPlaceholder = deriveMountName({ ...emptyLocalDraft(), workspaceDir: localDir });
  const urlPlaceholder = deriveMountName({ ...emptyLocalDraft(), kind: 'git-remote', repoUrl });

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add source</DialogTitle>
          </DialogHeader>
          {/* max-h backstop: overflow-y-auto only scrolls against a real
              constraint, and DialogContent has none — without this, tall
              provider bodies push the dialog past the viewport. */}
          <div className={cn('min-h-0 overflow-y-auto', 'flex max-h-[70vh] flex-col gap-5')}>
            <div className="flex flex-col gap-1">
              <label className="text-sm text-foreground">Source</label>
              <Select aria-label="Source type" value={provider} onChange={handleProvider} className="w-full">
                {githubLinked && <option value="github">GitHub</option>}
                <option value="azure">Azure DevOps</option>
                <option value="local">Local folder</option>
                <option value="url">Git URL</option>
              </Select>
            </div>

            {provider === 'github' &&
              (githubLinked ? (
                <RepoPicker
                  active={open && provider === 'github'}
                  loadScopes={githubLoadScopes}
                  searchRepos={githubSearch}
                  onSelect={handleRepoPick}
                  emptyHint={githubEmptyHint}
                />
              ) : (
                <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                  Connect a GitHub account in Settings → Git to browse repos, or use Git URL.
                </span>
              ))}

            {provider === 'azure' &&
              (azureLinked ? (
                <RepoPicker
                  active={open && provider === 'azure'}
                  manualScope={{ placeholder: 'Organization' }}
                  searchRepos={azureSearch}
                  onSelect={handleRepoPick}
                />
              ) : (
                <div className="flex flex-col gap-1">
                  <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
                    Add an Azure DevOps personal access token (Code: Read) to browse your repos.
                  </span>
                  <Button size="sm" onClick={openAzureToken}>
                    Add Azure DevOps token
                  </Button>
                </div>
              ))}

            {provider === 'local' && (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-foreground">Workspace directory</label>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-border bg-background px-4 py-2 text-sm text-muted-foreground">
                      {localDir || 'No directory selected'}
                    </span>
                    <Button size="sm" variant="ghost" onClick={openBrowse}>
                      Browse
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-foreground">
                    Mount name <span className="text-xs text-muted-foreground">(folder under /workspace/)</span>
                  </label>
                  <Input
                    aria-label="Source mount name"
                    type="text"
                    value={localMount}
                    onChange={handleLocalMount}
                    placeholder={localPlaceholder || 'e.g. launcher'}
                    className="w-full"
                  />
                </div>
              </>
            )}

            {provider === 'url' && (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-foreground">Repo URL</label>
                  <Input
                    aria-label="Repo URL"
                    type="text"
                    value={repoUrl}
                    onChange={handleRepoUrl}
                    placeholder="https://github.com/owner/name"
                    className="w-full"
                  />

                  <CredentialStatus repoUrl={repoUrl} credentials={credentials} onAddToken={setAddTokenHost} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-foreground">
                    Mount name <span className="text-xs text-muted-foreground">(folder under /workspace/)</span>
                  </label>
                  <Input
                    aria-label="Source mount name"
                    type="text"
                    value={urlMount}
                    onChange={handleUrlMount}
                    placeholder={urlPlaceholder || 'e.g. launcher'}
                    className="w-full"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-foreground">
                    Default branch <span className="text-xs text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    aria-label="Default branch"
                    type="text"
                    value={branch}
                    onChange={handleBranch}
                    placeholder="Leave blank for the repo's default branch"
                    className="w-full"
                  />
                </div>
              </>
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
            {/* GitHub adds on row click; local / URL fill then Add. */}
            {provider === 'local' && (
              <Button onClick={handleAddLocal} disabled={saving}>
                {saving ? 'Adding…' : 'Add source'}
              </Button>
            )}
            {provider === 'url' && (
              <Button onClick={handleAddUrl} disabled={saving}>
                {saving ? 'Adding…' : 'Add source'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DirectoryBrowserDialog
        open={browseDir}
        onClose={closeBrowse}
        onSelect={handleDirSelected}
        initialPath={localDir || undefined}
      />

      <GitCredentialDialog open={addTokenHost !== null} onClose={closeAddToken} initialHost={addTokenHost ?? ''} />
    </>
  );
});
AddSourceDialog.displayName = 'AddSourceDialog';
