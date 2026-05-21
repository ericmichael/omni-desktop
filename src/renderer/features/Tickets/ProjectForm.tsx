import { useStore } from '@nanostores/react';
import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { AnimatedDialog, Button, DialogBody, DialogContent, DialogFooter, DialogHeader, Input, Select, Switch } from '@/renderer/ds';
import {
  draftsToSources,
  type SourceDraft,
  SourcesEditor,
  sourcesToDrafts,
} from '@/renderer/features/Projects/SourcesEditor';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project } from '@/shared/types';

import { ticketApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

const useStyles = makeStyles({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: 'rgba(var(--colorNeutralBackground2), 0.5)',
    padding: tokens.spacingVerticalL,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  browseBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    textAlign: 'left',
    transitionProperty: 'border-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
  },
  browseText: {
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase400,
    '@media (min-width: 640px)': {
      fontSize: tokens.fontSizeBase300,
    },
  },
  browseTextFilled: {
    color: tokens.colorNeutralForeground1,
  },
  browseTextEmpty: {
    color: 'rgba(var(--colorNeutralForeground2), 0.5)',
  },
  browseLabel: {
    fontSize: tokens.fontSizeBase200,
    color: 'var(--accent-500)',
    fontWeight: tokens.fontWeightMedium,
    flexShrink: 0,
  },
  linkToggle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    padding: 0,
    fontWeight: tokens.fontWeightMedium,
  },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  switchLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  switchDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
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

  const [autoDispatch, setAutoDispatch] = useState(editProject?.autoDispatch ?? false);
  const [dueDate, setDueDate] = useState(
    editProject?.dueDate !== undefined ? toInputDate(editProject.dueDate) : ''
  );

  // Per-project sandbox profile (null = inherit user-default).
  const [sandboxProfile, setSandboxProfile] = useState<string | null>(
    editProject?.sandboxProfile ?? null
  );
  const [isEnterprise, setIsEnterprise] = useState(false);
  useEffect(() => {
    emitter.invoke('platform:is-enterprise').then(setIsEnterprise);
  }, []);
  const storeData = useStore(persistedStoreApi.$atom);
  const availableProfiles = useMemo(
    () => getAvailableProfileNames({ isEnterprise, available: storeData.availableSandboxProfiles }),
    [isEnterprise, storeData.availableSandboxProfiles]
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
        await ticketApi.updateProject(editProject.id, {
          label: label.trim(),
          sources: conv.sources,
          autoDispatch,
          sandboxProfile,
          dueDate: dueDateMs,
        });
      } else {
        await ticketApi.addProject({
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
  }, [isValid, isSubmitting, isEdit, editProject, label, drafts, autoDispatch, sandboxProfile, dueDate, onClose]);

  const handleDueDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDueDate(e.target.value);
  }, []);

  const hasAtLeastOneSource = drafts.length > 0;
  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>{isEdit ? 'Edit Project' : 'New Project'}</DialogHeader>
        <DialogBody className={styles.body}>
          {/* Name */}
          <div className={styles.section}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Name</label>
              <Input
                type="text"
                value={label}
                onChange={handleLabelChange}
                placeholder="my-project"
              />
            </div>
          </div>

          {/* Sources */}
          <div className={styles.section}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Sources</label>
              <SourcesEditor value={drafts} onChange={setDrafts} />
            </div>
          </div>

          {/* Sandbox — only in edit mode. New projects inherit the default. */}
          {isEdit && (
            <div className={styles.section}>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>Sandbox profile</label>
                <Select
                  value={sandboxProfile ?? INHERIT_PROFILE}
                  onChange={handleSandboxProfileChange}
                >
                  <option value={INHERIT_PROFILE}>Inherit default</option>
                  {availableProfiles.map((name) => (
                    <option key={name} value={name}>
                      {getProfileMenuLabel(name)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}

          {/* Auto-dispatch — only in edit mode with at least one source */}
          {isEdit && hasAtLeastOneSource && (
            <div className={styles.section}>
              <div className={styles.switchRow}>
                <div className={styles.switchLabel}>
                  <label className={styles.label}>Auto-dispatch</label>
                  <span className={styles.switchDescription}>Automatically assign and start tickets</span>
                </div>
                <Switch checked={autoDispatch} onCheckedChange={setAutoDispatch} />
              </div>
            </div>
          )}

          {/* Due date — optional */}
          <div className={styles.section}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Due date</label>
              <Input type="date" value={dueDate} onChange={handleDueDateChange} />
            </div>
          </div>

          {submitError && (
            <div role="alert" style={{ color: 'var(--colorPaletteRedForeground1)' }}>
              {submitError}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} isDisabled={!isValid || isSubmitting}>
            {isEdit ? 'Save' : 'Create Project'}
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
