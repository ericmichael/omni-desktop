import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import type { FleetProject, FleetSandboxConfig } from '@/shared/types';

import { DirectoryBrowserDialog } from './DirectoryBrowserDialog';
import { fleetApi } from './state';

type SandboxMode = 'default' | 'image' | 'dockerfile';

function deriveSandboxMode(sandbox?: FleetSandboxConfig | null): SandboxMode {
  if (sandbox?.image) return 'image';
  if (sandbox?.dockerfile) return 'dockerfile';
  return 'default';
}

function deriveSandboxValue(sandbox?: FleetSandboxConfig | null, mode?: SandboxMode): string {
  if (mode === 'image') return sandbox?.image ?? '';
  if (mode === 'dockerfile') return sandbox?.dockerfile ?? '';
  return '';
}

type FleetProjectFormProps = {
  open: boolean;
  onClose: () => void;
  editProject?: FleetProject;
};

export const FleetProjectForm = memo(({ open, onClose, editProject }: FleetProjectFormProps) => {
  const [label, setLabel] = useState(editProject?.label ?? '');
  const [workspaceDir, setWorkspaceDir] = useState(editProject?.workspaceDir ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  const initialSandboxMode = deriveSandboxMode(editProject?.sandbox);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(initialSandboxMode);
  const [sandboxValue, setSandboxValue] = useState(deriveSandboxValue(editProject?.sandbox, initialSandboxMode));

  const isEdit = Boolean(editProject);
  const isValid = label.trim().length > 0 && workspaceDir.trim().length > 0;

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

    const sandbox: FleetSandboxConfig | undefined =
      sandboxMode === 'image' && sandboxValue.trim()
        ? { image: sandboxValue.trim() }
        : sandboxMode === 'dockerfile' && sandboxValue.trim()
          ? { dockerfile: sandboxValue.trim() }
          : undefined;

    try {
      if (isEdit && editProject) {
        await fleetApi.updateProject(editProject.id, {
          label: label.trim(),
          workspaceDir: workspaceDir.trim(),
          sandbox: sandbox ?? null,
        });
      } else {
        await fleetApi.addProject({
          label: label.trim(),
          workspaceDir: workspaceDir.trim(),
          sandbox: sandbox ?? null,
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [isValid, isSubmitting, isEdit, editProject, label, workspaceDir, sandboxMode, sandboxValue, onClose]);

  const inputClassName =
    'w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500';

  return (
    <>
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>{isEdit ? 'Edit Project' : 'New Project'}</DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg">Name</label>
              <input
                type="text"
                value={label}
                onChange={handleLabelChange}
                placeholder="my-project"
                className={inputClassName}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg">Workspace Directory</label>
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg-muted">
                  {workspaceDir || 'No directory selected'}
                </span>
                <Button size="sm" variant="ghost" onClick={handleBrowseOpen}>
                  Browse
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-fg">Sandbox</label>
              <select
                value={sandboxMode}
                onChange={handleSandboxModeChange}
                className={inputClassName}
              >
                <option value="default">Default</option>
                <option value="image">Docker Image</option>
                <option value="dockerfile">Dockerfile</option>
              </select>
              {sandboxMode === 'image' && (
                <input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="ubuntu:24.04"
                  className={inputClassName}
                />
              )}
              {sandboxMode === 'dockerfile' && (
                <input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="Dockerfile"
                  className={inputClassName}
                />
              )}
            </div>
          </DialogBody>
          <DialogFooter className="gap-2 justify-end">
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
FleetProjectForm.displayName = 'FleetProjectForm';
