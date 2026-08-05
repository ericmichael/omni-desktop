import { useStore } from '@nanostores/react';
import { FolderOpen } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project } from '@/shared/types';

import { draftsToSources, emptyLocalDraft } from './source-draft';
import { projectsApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

type ProjectCreateDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Show the sandbox-profile select (used by Code's attach-project flow). */
  showSandboxProfile?: boolean;
  submitLabel?: string;
  onCreated?: (project: Project) => void;
};

/**
 * Consumer-first project creation. A name is enough; files and developer
 * connections are optional and can be added now or later in Settings.
 */
export const ProjectCreateDialog = memo(
  ({ open, onClose, showSandboxProfile = false, submitLabel, onCreated }: ProjectCreateDialogProps) => {
    const [label, setLabel] = useState('');
    const [sourceMode, setSourceMode] = useState<'local' | 'git-remote' | 'empty'>('empty');
    const [sourceValue, setSourceValue] = useState('');
    const [sandboxProfile, setSandboxProfile] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
      if (open) {
        setLabel('');
        setSourceMode('empty');
        setSourceValue('');
        setSandboxProfile(null);
      }
    }, [open]);

    const [isEnterprise, setIsEnterprise] = useState(false);
    useEffect(() => {
      emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
    }, []);
    const storeData = useStore(persistedStoreApi.$atom);
    // Subscribing keeps the options current as discovery lands.
    const discovered = useStore($sandboxProfiles);
    const availableProfiles = useMemo(
      () => getAvailableProfileNames({ isEnterprise, available: storeData.availableSandboxProfiles, discovered }),
      [isEnterprise, storeData.availableSandboxProfiles, discovered]
    );
    const suggestedLabel = useMemo(
      () =>
        sourceValue
          .replace(/\.git$/, '')
          .replace(/\/+$/, '')
          .split(/[/:]/)
          .pop() || 'Project name',
      [sourceValue]
    );

    const isValid = label.trim().length > 0 && (sourceMode === 'empty' || sourceValue.trim().length > 0);

    const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setLabel(e.target.value);
    }, []);
    const handleSandboxProfileChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      setSandboxProfile(e.target.value === INHERIT_PROFILE ? null : e.target.value);
    }, []);
    const handleSourceModeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      setSourceMode(e.target.value as 'local' | 'git-remote' | 'empty');
      setSourceValue('');
    }, []);
    const handleSourceValueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setSourceValue(e.target.value);
    }, []);
    const handleBrowse = useCallback(async () => {
      const selected = await emitter.invoke('util:select-directory');
      if (!selected) {
        return;
      }
      setSourceValue(selected);
      setLabel((current) => current || selected.replace(/\/+$/, '').split('/').pop() || 'Project');
    }, []);

    const handleSubmit = useCallback(async () => {
      if (!isValid || isSubmitting) {
        return;
      }
      setIsSubmitting(true);

      const slug =
        label
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || 'project';

      const draft = {
        ...emptyLocalDraft(),
        kind: sourceMode === 'git-remote' ? ('git-remote' as const) : ('local' as const),
        ...(sourceMode === 'git-remote' ? { repoUrl: sourceValue } : { workspaceDir: sourceValue }),
      };
      const result = sourceMode === 'empty' ? { ok: true as const, sources: [] } : draftsToSources([draft]);
      if (!result.ok) {
        setIsSubmitting(false);
        return;
      }

      try {
        const project = await projectsApi.addProject({
          label: label.trim(),
          slug,
          sources: result.sources,
          ...(sandboxProfile ? { sandboxProfile } : {}),
        });
        onCreated?.(project);
        onClose();
      } finally {
        setIsSubmitting(false);
      }
    }, [isValid, isSubmitting, label, sourceMode, sourceValue, sandboxProfile, onClose, onCreated]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          void handleSubmit();
        }
      },
      [handleSubmit]
    );

    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <div className={cn('min-h-0 overflow-y-auto', 'flex flex-col gap-5')}>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-foreground">Name</label>
              <Input
                aria-label="Project name"
                type="text"
                value={label}
                onChange={handleLabelChange}
                onKeyDown={handleKeyDown}
                placeholder={suggestedLabel}
                className="w-full"
                autoFocus
              />
            </div>

            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Connect files (optional)
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-foreground">Connection</label>
                  <Select aria-label="Project file connection" value={sourceMode} onChange={handleSourceModeChange}>
                    <option value="empty">None</option>
                    <option value="local">Folder on this computer</option>
                    <option value="git-remote">Git repository</option>
                  </Select>
                </div>

                {sourceMode === 'local' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm text-foreground">Folder</label>
                    <div className="flex gap-2">
                      <Input
                        aria-label="Project folder path"
                        value={sourceValue}
                        readOnly
                        placeholder="Choose a folder…"
                      />
                      <Button type="button" variant="outline" onClick={handleBrowse}>
                        <FolderOpen />
                        Browse
                      </Button>
                    </div>
                  </div>
                )}

                {sourceMode === 'git-remote' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm text-foreground">Git URL</label>
                    <Input
                      aria-label="Project Git URL"
                      value={sourceValue}
                      onChange={handleSourceValueChange}
                      placeholder="https://github.com/owner/repository"
                    />
                  </div>
                )}
              </div>
            </details>

            {showSandboxProfile && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-foreground">Sandbox</label>
                <Select
                  aria-label="Sandbox profile"
                  value={sandboxProfile ?? INHERIT_PROFILE}
                  onChange={handleSandboxProfileChange}
                  className="w-full"
                >
                  <option value={INHERIT_PROFILE}>Inherit default</option>
                  {availableProfiles.map((name) => (
                    <option key={name} value={name}>
                      {getProfileMenuLabel(name)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
              {submitLabel ?? 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
ProjectCreateDialog.displayName = 'ProjectCreateDialog';
