import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, Button, cn, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import type { Project, SandboxConfig } from '@/shared/types';

import { DirectoryBrowserDialog } from './DirectoryBrowserDialog';
import { ticketApi } from './state';

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

const SANDBOX_OPTIONS: { value: SandboxMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'image', label: 'Docker Image' },
  { value: 'dockerfile', label: 'Dockerfile' },
];

type ProjectFormProps = {
  open: boolean;
  onClose: () => void;
  editProject?: Project;
};

const inputClass =
  'w-full rounded-xl border border-surface-border bg-surface px-3.5 py-2.5 text-base sm:text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 transition-colors';

export const ProjectForm = memo(({ open, onClose, editProject }: ProjectFormProps) => {
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

  const handleSandboxModeChange = useCallback((mode: SandboxMode) => {
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

    try {
      if (isEdit && editProject) {
        await ticketApi.updateProject(editProject.id, {
          label: label.trim(),
          workspaceDir: workspaceDir.trim(),
          sandbox: sandbox ?? null,
        });
      } else {
        await ticketApi.addProject({
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

  return (
    <>
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>{isEdit ? 'Edit Project' : 'New Project'}</DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {/* Name & Directory */}
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-fg-muted uppercase tracking-wider">Name</label>
                <input
                  type="text"
                  value={label}
                  onChange={handleLabelChange}
                  placeholder="my-project"
                  className={inputClass}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-fg-muted uppercase tracking-wider">Directory</label>
                <button
                  type="button"
                  onClick={handleBrowseOpen}
                  className="flex items-center gap-2 w-full rounded-xl border border-surface-border bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-accent-500/50"
                >
                  <span className={cn('flex-1 truncate text-base sm:text-sm', workspaceDir ? 'text-fg' : 'text-fg-muted/50')}>
                    {workspaceDir || 'Tap to select directory'}
                  </span>
                  <span className="text-xs text-accent-500 font-medium shrink-0">Browse</span>
                </button>
              </div>
            </div>

            {/* Sandbox */}
            <div className="flex flex-col gap-3 rounded-2xl bg-surface-raised/50 p-4 border border-surface-border">
              <label className="text-xs font-medium text-fg-muted uppercase tracking-wider">Sandbox</label>
              <div className="flex items-center gap-1.5">
                {SANDBOX_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSandboxModeChange(opt.value)}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                      sandboxMode === opt.value
                        ? 'bg-accent-600/20 text-accent-400'
                        : 'bg-surface-overlay text-fg-muted hover:text-fg'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {sandboxMode === 'image' && (
                <input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="ubuntu:24.04"
                  className={inputClass}
                />
              )}
              {sandboxMode === 'dockerfile' && (
                <input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="Dockerfile"
                  className={inputClass}
                />
              )}
            </div>
          </DialogBody>
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-end">
            <Button onClick={handleSubmit} isDisabled={!isValid || isSubmitting} className="w-full sm:w-auto justify-center">
              {isEdit ? 'Save' : 'Create Project'}
            </Button>
            <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto justify-center">
              Cancel
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
