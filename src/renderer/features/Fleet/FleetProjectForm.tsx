import { memo, useCallback, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type { FleetProject } from '@/shared/types';

import { fleetApi } from './state';

type FleetProjectFormProps = {
  open: boolean;
  onClose: () => void;
  editProject?: FleetProject;
};

export const FleetProjectForm = memo(({ open, onClose, editProject }: FleetProjectFormProps) => {
  const [label, setLabel] = useState(editProject?.label ?? '');
  const [workspaceDir, setWorkspaceDir] = useState(editProject?.workspaceDir ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEdit = Boolean(editProject);
  const isValid = label.trim().length > 0 && workspaceDir.trim().length > 0;

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
  }, []);

  const handleSelectDir = useCallback(async () => {
    const dir = await emitter.invoke('util:select-directory', workspaceDir || undefined);
    if (dir) {
      setWorkspaceDir(dir);
      if (!label.trim()) {
        const parts = dir.split('/');
        setLabel(parts[parts.length - 1] ?? '');
      }
    }
  }, [workspaceDir, label]);

  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      if (isEdit && editProject) {
        await fleetApi.updateProject(editProject.id, {
          label: label.trim(),
          workspaceDir: workspaceDir.trim(),
        });
      } else {
        await fleetApi.addProject({
          label: label.trim(),
          workspaceDir: workspaceDir.trim(),
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [isValid, isSubmitting, isEdit, editProject, label, workspaceDir, onClose]);

  return (
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
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-fg">Workspace Directory</label>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-fg-muted">
                {workspaceDir || 'No directory selected'}
              </span>
              <Button size="sm" variant="ghost" onClick={handleSelectDir}>
                Browse
              </Button>
            </div>
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
  );
});
FleetProjectForm.displayName = 'FleetProjectForm';
