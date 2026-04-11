import { makeStyles, tokens, shorthands } from '@fluentui/react-components';
import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, Select } from '@/renderer/ds';
import { DirectoryBrowserDialog } from '@/renderer/features/Tickets/DirectoryBrowserDialog';
import type { Project, SandboxConfig } from '@/shared/types';

import { projectsApi } from './state';

type SourceKind = 'local' | 'git-remote';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  fullWidth: { width: '100%' },
  dirRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  dirDisplay: {
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  footer: { gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

type SandboxMode = 'default' | 'image' | 'dockerfile';

function deriveSandboxMode(sandbox?: SandboxConfig | null): SandboxMode {
  if (sandbox?.image) return 'image';
  if (sandbox?.dockerfile) return 'dockerfile';
  return 'default';
}

function deriveSandboxValue(sandbox?: SandboxConfig | null, mode?: SandboxMode): string {
  if (mode === 'image') return sandbox?.image ?? '';
  if (mode === 'dockerfile') return sandbox?.dockerfile ?? '';
  return '';
}

type ProjectFormProps = {
  open: boolean;
  onClose: () => void;
  editProject?: Project;
};

export const ProjectForm = memo(({ open, onClose, editProject }: ProjectFormProps) => {
  const styles = useStyles();
  const [label, setLabel] = useState(editProject?.label ?? '');
  const [sourceKind, setSourceKind] = useState<SourceKind>(editProject?.source.kind === 'git-remote' ? 'git-remote' : 'local');
  const [workspaceDir, setWorkspaceDir] = useState(editProject?.source.kind === 'local' ? editProject.source.workspaceDir : '');
  const [repoUrl, setRepoUrl] = useState(editProject?.source.kind === 'git-remote' ? editProject.source.repoUrl : '');
  const [defaultBranch, setDefaultBranch] = useState(editProject?.source.kind === 'git-remote' ? (editProject.source.defaultBranch ?? '') : '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const initialSandboxMode = deriveSandboxMode(editProject?.sandbox);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(initialSandboxMode);
  const [sandboxValue, setSandboxValue] = useState(deriveSandboxValue(editProject?.sandbox, initialSandboxMode));

  const isEdit = Boolean(editProject);
  const isValid =
    label.trim().length > 0 &&
    (sourceKind === 'local' ? workspaceDir.trim().length > 0 : repoUrl.trim().length > 0);

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
  }, []);

  const handleBrowseOpen = useCallback(() => setBrowseOpen(true), []);
  const handleBrowseClose = useCallback(() => setBrowseOpen(false), []);

  const handleDirSelected = useCallback(
    (dir: string) => {
      setWorkspaceDir(dir);
      if (!label.trim()) {
        const parts = dir.split('/');
        setLabel(parts[parts.length - 1] ?? '');
      }
    },
    [label]
  );

  const handleSourceKindChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSourceKind(e.target.value as SourceKind);
  }, []);

  const handleRepoUrlChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRepoUrl(e.target.value);
    if (!label.trim()) {
      const match = e.target.value.match(/\/([^/]+?)(?:\.git)?$/);
      if (match?.[1]) setLabel(match[1]);
    }
  }, [label]);

  const handleDefaultBranchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDefaultBranch(e.target.value);
  }, []);

  const handleSandboxModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value as SandboxMode;
    setSandboxMode(mode);
    if (mode === 'default') setSandboxValue('');
  }, []);

  const handleSandboxValueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSandboxValue(e.target.value);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) {
      return;
    }
    setIsSubmitting(true);

    const sandbox: SandboxConfig | undefined =
      sandboxMode === 'image' && sandboxValue.trim()
        ? { image: sandboxValue.trim() }
        : sandboxMode === 'dockerfile' && sandboxValue.trim()
          ? { dockerfile: sandboxValue.trim() }
          : undefined;

    const source =
      sourceKind === 'local'
        ? { kind: 'local' as const, workspaceDir: workspaceDir.trim() }
        : {
            kind: 'git-remote' as const,
            repoUrl: repoUrl.trim(),
            ...(defaultBranch.trim() ? { defaultBranch: defaultBranch.trim() } : {}),
          };

    try {
      if (isEdit && editProject) {
        await projectsApi.updateProject(editProject.id, {
          label: label.trim(),
          source,
          sandbox: sandbox ?? null,
        });
      } else {
        await projectsApi.addProject({
          label: label.trim(),
          source,
          sandbox: sandbox ?? null,
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [isValid, isSubmitting, isEdit, editProject, label, sourceKind, workspaceDir, repoUrl, defaultBranch, sandboxMode, sandboxValue, onClose]);

  return (
    <>
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>{isEdit ? 'Edit Project' : 'New Project'}</DialogHeader>
          <DialogBody className={styles.body}>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <Input
                type="text"
                value={label}
                onChange={handleLabelChange}
                placeholder="my-project"
                className={styles.fullWidth}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Source</label>
              <Select value={sourceKind} onChange={handleSourceKindChange} className={styles.fullWidth}>
                <option value="local">Local Directory</option>
                <option value="git-remote">Git Repository</option>
              </Select>
            </div>

            {sourceKind === 'local' && (
              <div className={styles.field}>
                <label className={styles.label}>Workspace Directory</label>
                <div className={styles.dirRow}>
                  <span className={styles.dirDisplay}>
                    {workspaceDir || 'No directory selected'}
                  </span>
                  <Button size="sm" variant="ghost" onClick={handleBrowseOpen}>
                    Browse
                  </Button>
                </div>
              </div>
            )}

            {sourceKind === 'git-remote' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Repository URL</label>
                  <Input
                    type="text"
                    value={repoUrl}
                    onChange={handleRepoUrlChange}
                    placeholder="https://github.com/org/repo.git"
                    className={styles.fullWidth}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Default Branch (optional)</label>
                  <Input
                    type="text"
                    value={defaultBranch}
                    onChange={handleDefaultBranchChange}
                    placeholder="main"
                    className={styles.fullWidth}
                  />
                </div>
              </>
            )}

            <div className={styles.field}>
              <label className={styles.label}>Sandbox</label>
              <Select
                value={sandboxMode}
                onChange={handleSandboxModeChange}
                className={styles.fullWidth}
              >
                <option value="default">Default</option>
                <option value="image">Docker Image</option>
                <option value="dockerfile">Dockerfile</option>
              </Select>
              {sandboxMode === 'image' && (
                <Input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="ubuntu:24.04"
                  className={styles.fullWidth}
                />
              )}
              {sandboxMode === 'dockerfile' && (
                <Input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="Dockerfile"
                  className={styles.fullWidth}
                />
              )}
            </div>
          </DialogBody>
          <DialogFooter className={styles.footer}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} isDisabled={!isValid || isSubmitting}>
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
      <DirectoryBrowserDialog
        open={browseOpen}
        onClose={handleBrowseClose}
        onSelect={handleDirSelected}
        initialPath={workspaceDir || undefined}
      />
    </>
  );
});
ProjectForm.displayName = 'ProjectForm';
