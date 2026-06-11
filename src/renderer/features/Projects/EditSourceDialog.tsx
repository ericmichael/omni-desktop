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
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Input,
} from '@/renderer/ds';
import { GitCredentialDialog } from '@/renderer/features/SettingsModal/GitCredentialDialog';
import { DirectoryBrowserDialog } from '@/renderer/features/Tickets/DirectoryBrowserDialog';
import { persistedStoreApi } from '@/renderer/services/store';
import { duplicateSourceIdentityMessage, sourceIdentityKey } from '@/shared/project-source';
import type { Project, ProjectSource } from '@/shared/types';

import { CredentialStatus } from './CredentialStatus';
import { deriveMountName, emptyLocalDraft } from './source-draft';
import { projectsApi } from './state';

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
  footer: { gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

type EditSourceDialogProps = {
  open: boolean;
  onClose: () => void;
  project: Project;
  source: ProjectSource;
};

export const EditSourceDialog = memo(({ open, onClose, project, source }: EditSourceDialogProps) => {
  const styles = useStyles();
  const storeData = useStore(persistedStoreApi.$atom);
  const credentials = storeData.gitCredentials ?? [];

  const isLocal = source.kind === 'local';

  const [mount, setMount] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
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
        ? { id: source.id, mountName, kind: 'local', workspaceDir: path }
        : { id: source.id, mountName, kind: 'git-remote', repoUrl: path, ...(trimmedBranch ? { defaultBranch: trimmedBranch } : {}) };

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
  }, [isLocal, workspaceDir, repoUrl, mount, branch, project.id, project.sources, source, onClose]);

  const mountPlaceholder = deriveMountName(
    isLocal
      ? { ...emptyLocalDraft(), workspaceDir }
      : { ...emptyLocalDraft(), kind: 'git-remote', repoUrl }
  );

  return (
    <>
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>Edit source</DialogHeader>
          <DialogBody className={styles.body}>
            {isLocal ? (
              <div className={styles.field}>
                <label className={styles.label}>Workspace directory</label>
                <div className={styles.dirRow}>
                  <span className={styles.dirDisplay}>{workspaceDir || 'No directory selected'}</span>
                  <Button size="sm" variant="ghost" onClick={openBrowse}>
                    Browse
                  </Button>
                </div>
              </div>
            ) : (
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
            )}

            <div className={styles.field}>
              <label className={styles.label}>
                Mount name <span className={styles.hint}>(folder under /workspace/)</span>
              </label>
              <Input
                type="text"
                value={mount}
                onChange={handleMount}
                placeholder={mountPlaceholder || 'e.g. launcher'}
                className={styles.full}
              />
            </div>

            {!isLocal && (
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
            <Button onClick={handleSave} isDisabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
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
