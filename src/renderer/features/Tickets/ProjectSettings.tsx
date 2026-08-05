import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Switch } from '@/renderer/ds/ui/switch';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { PipelineEditor } from './PipelineEditor';
import { ProjectPageHeader } from './ProjectPageHeader';
import { ProjectSourcesSettings } from './ProjectSourcesSettings';
import { ticketApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

/**
 * The shell's Settings tab — the single place a project is configured.
 * Scalar fields save on change/blur; the pipeline edits a draft with an
 * explicit save (structural changes shouldn't thrash running agents).
 */
export const ProjectSettings = memo(({ projectId }: { projectId: ProjectId }) => {
  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  const [name, setName] = useState(project?.label ?? '');

  // Keep the name buffer in sync with external renames (shell header, root page).
  const projectLabel = project?.label;
  useEffect(() => {
    if (projectLabel !== undefined) {
      setName(projectLabel);
    }
  }, [projectLabel]);

  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);
  // Subscribing keeps the options current as discovery lands.
  const discovered = useStore($sandboxProfiles);
  const availableProfiles = useMemo(
    () => getAvailableProfileNames({ isEnterprise, available: store.availableSandboxProfiles, discovered }),
    [isEnterprise, store.availableSandboxProfiles, discovered]
  );

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);
  const handleNameBlur = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed && project && trimmed !== project.label) {
      void ticketApi.renameProject(projectId, trimmed);
    }
  }, [name, project, projectId]);
  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleNameBlur();
      }
    },
    [handleNameBlur]
  );

  const handleDueDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      void ticketApi.updateProject(projectId, { dueDate: fromInputDate(e.target.value) });
    },
    [projectId]
  );

  const handleSandboxProfileChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void ticketApi.updateProject(projectId, {
        sandboxProfile: e.target.value === INHERIT_PROFILE ? null : e.target.value,
      });
    },
    [projectId]
  );

  const handleAutoDispatchChange = useCallback(
    (checked: boolean) => {
      void ticketApi.updateProject(projectId, { autoDispatch: checked });
    },
    [projectId]
  );

  if (!project) {
    return null;
  }

  return (
    <div className="h-full overflow-y-auto" data-slot="project-settings">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-6 py-6">
        <ProjectPageHeader title="Settings" className="pl-0 pr-0 pt-0 pb-0" />

        {/* General */}
        <div className="flex flex-col gap-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">General</span>
          <div className="flex flex-col gap-1 max-w-sm">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              aria-label="Project name"
              type="text"
              value={name}
              onChange={handleNameChange}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
            />
          </div>
          <div className="flex flex-col gap-1 max-w-sm">
            <label className="text-xs text-muted-foreground">Due date</label>
            <Input
              aria-label="Project due date"
              type="date"
              value={project.dueDate !== undefined ? toInputDate(project.dueDate) : ''}
              onChange={handleDueDateChange}
            />
          </div>
        </div>

        <ProjectSourcesSettings projectId={projectId} />

        <details className="rounded-xl border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Advanced
          </summary>
          <div className="mt-5 flex flex-col gap-7">
            <div className="flex flex-col gap-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Agent environment
              </span>
              <div className="flex flex-col gap-1 max-w-sm">
                <label className="text-xs text-muted-foreground">Sandbox profile</label>
                <Select
                  aria-label="Sandbox profile"
                  value={project.sandboxProfile ?? INHERIT_PROFILE}
                  onChange={handleSandboxProfileChange}
                >
                  <option value={INHERIT_PROFILE}>Inherit default</option>
                  {availableProfiles.map((profileName) => (
                    <option key={profileName} value={profileName}>
                      {getProfileMenuLabel(profileName)}
                    </option>
                  ))}
                </Select>
              </div>
              {project.sources.length > 0 && (
                <div className="flex items-center justify-between gap-4 max-w-lg">
                  <div className="flex flex-col gap-0.5">
                    <label className="text-xs text-muted-foreground">Automatic task assignment</label>
                    <span className="text-xs text-muted-foreground">Let Omni begin queued tasks automatically</span>
                  </div>
                  <Switch checked={project.autoDispatch ?? false} onCheckedChange={handleAutoDispatchChange} />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Task workflow
              </span>
              <PipelineEditor projectId={projectId} />
            </div>
          </div>
        </details>
      </div>
    </div>
  );
});
ProjectSettings.displayName = 'ProjectSettings';

/** Format an epoch-ms timestamp as a local YYYY-MM-DD string for <input type="date">. */
function toInputDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD input value into an epoch-ms at local midnight, or undefined. */
function fromInputDate(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) {
    return undefined;
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
