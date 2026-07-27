import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Caption1, ConfirmDialog, Input, SectionLabel, Select, Switch } from '@/renderer/ds';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ProjectId } from '@/shared/types';

import { PipelineEditor } from './PipelineEditor';
import { ProjectPageHeader } from './ProjectPageHeader';
import { ticketApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

const useStyles = makeStyles({
  root: {
    height: '100%',
    overflowY: 'auto',
  },
  container: {
    maxWidth: '720px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '24px',
    paddingBottom: '48px',
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
  },
  /* The container already pads horizontally — zero the header's own padding
     so the title aligns with the sections below. */
  pageHeader: {
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxWidth: '360px',
  },
  fieldLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    maxWidth: '480px',
  },
  switchLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  danger: {
    ...shorthands.border('1px', 'solid', tokens.colorPaletteRedBorder1),
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  dangerText: {
    flex: '1 1 0',
    minWidth: 0,
  },
});

/**
 * The shell's Settings tab — the single place a project is configured.
 * Scalar fields save on change/blur; the pipeline edits a draft with an
 * explicit save (structural changes shouldn't thrash running agents).
 */
export const ProjectSettings = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  const [name, setName] = useState(project?.label ?? '');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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

  const handleOpenDelete = useCallback(() => setDeleteConfirmOpen(true), []);
  const handleCloseDelete = useCallback(() => setDeleteConfirmOpen(false), []);
  const handleDelete = useCallback(async () => {
    await ticketApi.removeProject(projectId);
    ticketApi.goToAllWork();
  }, [projectId]);

  if (!project) {
    return null;
  }

  return (
    <div className={styles.root} data-slot="project-settings">
      <div className={styles.container}>
        <ProjectPageHeader projectId={projectId} title="Settings" className={styles.pageHeader} />

        {/* General */}
        <div className={styles.section}>
          <SectionLabel>General</SectionLabel>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <Input
              aria-label="Project name"
              type="text"
              value={name}
              onChange={handleNameChange}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Due date</label>
            <Input
              aria-label="Project due date"
              type="date"
              value={project.dueDate !== undefined ? toInputDate(project.dueDate) : ''}
              onChange={handleDueDateChange}
            />
          </div>
        </div>

        {/* Execution */}
        <div className={styles.section}>
          <SectionLabel>Execution</SectionLabel>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Sandbox profile</label>
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
            <div className={styles.switchRow}>
              <div className={styles.switchLabel}>
                <label className={styles.fieldLabel}>Auto-dispatch</label>
                <Caption1>Automatically assign and start tickets from the backlog</Caption1>
              </div>
              <Switch checked={project.autoDispatch ?? false} onCheckedChange={handleAutoDispatchChange} />
            </div>
          )}
        </div>

        {/* Pipeline */}
        <div className={styles.section}>
          <SectionLabel>Pipeline</SectionLabel>
          <PipelineEditor projectId={projectId} />
        </div>

        {/* Danger zone */}
        {!project.isPersonal && (
          <div className={styles.section}>
            <SectionLabel>Danger zone</SectionLabel>
            <div className={styles.danger}>
              <Caption1 className={styles.dangerText}>
                Deletes the project and all its tickets. Workspace files are not affected.
              </Caption1>
              <Button variant="destructive" onClick={handleOpenDelete}>
                Delete project
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={handleCloseDelete}
        onConfirm={handleDelete}
        title="Delete project?"
        description="This will remove the project and all its tickets. Your workspace files will not be affected."
        confirmLabel="Delete"
        destructive
      />
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
