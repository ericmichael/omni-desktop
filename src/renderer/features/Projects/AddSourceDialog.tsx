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
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  Caption1,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Input,
  Select,
} from '@/renderer/ds';
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

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  hint: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  full: { width: '100%' },
  dirRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  dirDisplay: {
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  notLinked: { color: tokens.colorNeutralForeground3 },
  footer: { gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

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
  const styles = useStyles();
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
      };
      void addDraft({ ...draft, mountName: deriveMountName(draft) }, true);
    },
    [addDraft]
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
    void addDraft({ ...emptyLocalDraft(), kind: 'local', workspaceDir: localDir, mountName: localMount }, false);
  }, [addDraft, localDir, localMount]);

  // Git URL
  const handleRepoUrl = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(e.target.value), []);
  const handleUrlMount = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setUrlMount(e.target.value), []);
  const handleBranch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value), []);
  const closeAddToken = useCallback(() => setAddTokenHost(null), []);
  const handleAddUrl = useCallback(() => {
    void addDraft(
      { ...emptyLocalDraft(), kind: 'git-remote', repoUrl, defaultBranch: branch, mountName: urlMount },
      false
    );
  }, [addDraft, repoUrl, branch, urlMount]);

  const localPlaceholder = deriveMountName({ ...emptyLocalDraft(), workspaceDir: localDir });
  const urlPlaceholder = deriveMountName({ ...emptyLocalDraft(), kind: 'git-remote', repoUrl });

  return (
    <>
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>Add source</DialogHeader>
          <DialogBody className={styles.body}>
            <div className={styles.field}>
              <label className={styles.label}>Source</label>
              <Select value={provider} onChange={handleProvider} className={styles.full}>
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
                <Caption1 className={styles.notLinked}>
                  Connect a GitHub account in Settings → Git to browse repos, or use Git URL.
                </Caption1>
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
                <div className={styles.field}>
                  <Caption1 className={styles.notLinked}>
                    Add an Azure DevOps personal access token (Code: Read) to browse your repos.
                  </Caption1>
                  <Button size="sm" onClick={openAzureToken}>
                    Add Azure DevOps token
                  </Button>
                </div>
              ))}

            {provider === 'local' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Workspace directory</label>
                  <div className={styles.dirRow}>
                    <span className={styles.dirDisplay}>{localDir || 'No directory selected'}</span>
                    <Button size="sm" variant="ghost" onClick={openBrowse}>
                      Browse
                    </Button>
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Mount name <span className={styles.hint}>(folder under /workspace/)</span>
                  </label>
                  <Input
                    type="text"
                    value={localMount}
                    onChange={handleLocalMount}
                    placeholder={localPlaceholder || 'e.g. launcher'}
                    className={styles.full}
                  />
                </div>
              </>
            )}

            {provider === 'url' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Repo URL</label>
                  <Input
                    type="text"
                    value={repoUrl}
                    onChange={handleRepoUrl}
                    placeholder="https://github.com/owner/name"
                    className={styles.full}
                  />
                  <CredentialStatus repoUrl={repoUrl} credentials={credentials} onAddToken={setAddTokenHost} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Mount name <span className={styles.hint}>(folder under /workspace/)</span>
                  </label>
                  <Input
                    type="text"
                    value={urlMount}
                    onChange={handleUrlMount}
                    placeholder={urlPlaceholder || 'e.g. launcher'}
                    className={styles.full}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Default branch <span className={styles.hint}>(optional)</span>
                  </label>
                  <Input
                    type="text"
                    value={branch}
                    onChange={handleBranch}
                    placeholder="Leave blank for the repo's default branch"
                    className={styles.full}
                  />
                </div>
              </>
            )}

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
            {/* GitHub adds on row click; local / URL fill then Add. */}
            {provider === 'local' && (
              <Button onClick={handleAddLocal} isDisabled={saving}>
                {saving ? 'Adding…' : 'Add source'}
              </Button>
            )}
            {provider === 'url' && (
              <Button onClick={handleAddUrl} isDisabled={saving}>
                {saving ? 'Adding…' : 'Add source'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
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
