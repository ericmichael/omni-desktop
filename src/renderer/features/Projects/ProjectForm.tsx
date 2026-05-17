import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, Select } from '@/renderer/ds';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import type { Project } from '@/shared/types';

import { draftsToSources, type SourceDraft, SourcesEditor, sourcesToDrafts } from './SourcesEditor';
import { projectsApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

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
  linkToggle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    fontWeight: tokens.fontWeightMedium,
    textAlign: 'left',
  },
});

type ProjectFormProps = {
  open: boolean;
  onClose: () => void;
  editProject?: Project;
};

export const ProjectForm = memo(({ open, onClose, editProject }: ProjectFormProps) => {
  const styles = useStyles();
  const isEdit = Boolean(editProject);

  const [label, setLabel] = useState(editProject?.label ?? '');
  const [drafts, setDrafts] = useState<SourceDraft[]>(() => sourcesToDrafts(editProject?.sources ?? []));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [dueDate, setDueDate] = useState(
    editProject?.dueDate !== undefined ? toInputDate(editProject.dueDate) : ''
  );

  // Per-project sandbox profile. ``null``/missing means "inherit user-default".
  const [sandboxProfile, setSandboxProfile] = useState<string | null>(
    editProject?.sandboxProfile ?? null
  );
  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);
  const availableProfiles = useMemo(
    () => getAvailableProfileNames({ isEnterprise }),
    [isEnterprise]
  );
  const handleSandboxProfileChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSandboxProfile(e.target.value === INHERIT_PROFILE ? null : e.target.value);
    },
    []
  );

  const isValid = label.trim().length > 0;

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLabel(e.target.value);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) {
      return;
    }
    const conv = draftsToSources(drafts);
    if (!conv.ok) {
      setSubmitError(conv.error);
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);

    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
    const dueDateMs = fromInputDate(dueDate);

    try {
      if (isEdit && editProject) {
        await projectsApi.updateProject(editProject.id, {
          label: label.trim(),
          sources: conv.sources,
          sandboxProfile,
          dueDate: dueDateMs,
        });
      } else {
        await projectsApi.addProject({
          label: label.trim(),
          slug,
          sources: conv.sources,
          ...(sandboxProfile ? { sandboxProfile } : {}),
          ...(dueDateMs !== undefined ? { dueDate: dueDateMs } : {}),
        });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }, [isValid, isSubmitting, isEdit, editProject, label, drafts, sandboxProfile, dueDate, onClose]);

  const handleDueDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDueDate(e.target.value);
  }, []);

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent className="max-w-lg">
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
            <label className={styles.label}>Sources</label>
            <SourcesEditor value={drafts} onChange={setDrafts} />
          </div>

          {/* Sandbox — only in edit mode. New projects inherit the default. */}
          {isEdit && (
            <div className={styles.field}>
              <label className={styles.label}>Sandbox</label>
              <Select
                value={sandboxProfile ?? INHERIT_PROFILE}
                onChange={handleSandboxProfileChange}
                className={styles.fullWidth}
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

          <div className={styles.field}>
            <label className={styles.label}>Due date</label>
            <Input
              type="date"
              value={dueDate}
              onChange={handleDueDateChange}
              className={styles.fullWidth}
            />
          </div>

          {submitError && (
            <div role="alert" style={{ color: 'var(--colorPaletteRedForeground1)' }}>
              {submitError}
            </div>
          )}
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
  );
});
ProjectForm.displayName = 'ProjectForm';

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
