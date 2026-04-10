import { memo, useCallback, useState } from 'react';
import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';

import { AnimatedDialog, Button, cn, DialogBody, DialogContent, DialogFooter, DialogHeader, Input } from '@/renderer/ds';
import type { Project, SandboxConfig } from '@/shared/types';

import { DirectoryBrowserDialog } from './DirectoryBrowserDialog';
import { ticketApi } from './state';

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
    ':hover': {
      ...shorthands.borderColor('rgba(99, 102, 241, 0.5)'),
    },
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
  sandboxOptions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  sandboxBtn: {
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: '9999px',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    border: 'none',
    cursor: 'pointer',
  },
  sandboxBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    color: '#818cf8',
  },
  sandboxBtnInactive: {
    backgroundColor: tokens.colorNeutralBackground1Hover,
    color: tokens.colorNeutralForeground2,
    ':hover': {
      color: tokens.colorNeutralForeground1,
    },
  },
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


export const ProjectForm = memo(({ open, onClose, editProject }: ProjectFormProps) => {
  const styles = useStyles();
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
          <DialogBody className={styles.body}>
            {/* Name & Directory */}
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

              <div className={styles.fieldGroup}>
                <label className={styles.label}>Directory</label>
                <button
                  type="button"
                  onClick={handleBrowseOpen}
                  className={styles.browseBtn}
                >
                  <span className={mergeClasses(styles.browseText, workspaceDir ? styles.browseTextFilled : styles.browseTextEmpty)}>
                    {workspaceDir || 'Tap to select directory'}
                  </span>
                  <span className={styles.browseLabel}>Browse</span>
                </button>
              </div>
            </div>

            {/* Sandbox */}
            <div className={styles.section}>
              <label className={styles.label}>Sandbox</label>
              <div className={styles.sandboxOptions}>
                {SANDBOX_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSandboxModeChange(opt.value)}
                    className={mergeClasses(
                      styles.sandboxBtn,
                      sandboxMode === opt.value ? styles.sandboxBtnActive : styles.sandboxBtnInactive
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {sandboxMode === 'image' && (
                <Input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="ubuntu:24.04"
                />
              )}
              {sandboxMode === 'dockerfile' && (
                <Input
                  type="text"
                  value={sandboxValue}
                  onChange={handleSandboxValueChange}
                  placeholder="Dockerfile"
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
