import { makeStyles, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Input,
  Select,
} from '@/renderer/ds';
import { $sandboxProfiles } from '@/renderer/features/Sandboxes/state';
import { getAvailableProfileNames, getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Project } from '@/shared/types';

import { projectsApi } from './state';

/** Sentinel value for the "Inherit default" option in the profile <Select>. */
const INHERIT_PROFILE = '__inherit__';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  fullWidth: { width: '100%' },
  footer: { gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
});

type ProjectCreateDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Show the sandbox-profile select (used by Code's attach-project flow). */
  showSandboxProfile?: boolean;
  submitLabel?: string;
  onCreated?: (project: Project) => void;
};

/**
 * Minimal project creation: a name (± sandbox profile), then land on the new
 * project's homepage where everything else — sources, pages, pipeline — is
 * configured in place. There is deliberately no edit mode: the Settings tab
 * of the project shell is where existing projects are edited.
 */
export const ProjectCreateDialog = memo(
  ({ open, onClose, showSandboxProfile = false, submitLabel, onCreated }: ProjectCreateDialogProps) => {
    const styles = useStyles();

    const [label, setLabel] = useState('');
    const [sandboxProfile, setSandboxProfile] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
      if (open) {
        setLabel('');
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

    const isValid = label.trim().length > 0;

    const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setLabel(e.target.value);
    }, []);
    const handleSandboxProfileChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      setSandboxProfile(e.target.value === INHERIT_PROFILE ? null : e.target.value);
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

      try {
        const project = await projectsApi.addProject({
          label: label.trim(),
          slug,
          sources: [],
          ...(sandboxProfile ? { sandboxProfile } : {}),
        });
        onCreated?.(project);
        onClose();
      } finally {
        setIsSubmitting(false);
      }
    }, [isValid, isSubmitting, label, sandboxProfile, onClose, onCreated]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          void handleSubmit();
        }
      },
      [handleSubmit]
    );

    return (
      <AnimatedDialog open={open} onClose={onClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>New Project</DialogHeader>
          <DialogBody className={styles.body}>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <Input
                aria-label="Project name"
                type="text"
                value={label}
                onChange={handleLabelChange}
                onKeyDown={handleKeyDown}
                placeholder="my-project"
                className={styles.fullWidth}
                autoFocus
              />
            </div>

            {showSandboxProfile && (
              <div className={styles.field}>
                <label className={styles.label}>Sandbox</label>
                <Select
                  aria-label="Sandbox profile"
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
          </DialogBody>
          <DialogFooter className={styles.footer}>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} isDisabled={!isValid || isSubmitting}>
              {submitLabel ?? 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </AnimatedDialog>
    );
  }
);
ProjectCreateDialog.displayName = 'ProjectCreateDialog';
