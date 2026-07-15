import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Globe20Regular,
  MusicNote220Regular,
  News20Regular,
  People20Regular,
  PersonBoard20Regular,
  SlideLayout20Regular,
  Star20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import { memo, useEffect, useState } from 'react';

import { uuidv4 } from '@/lib/uuid';
import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
  Switch,
} from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CustomAppEntry } from '@/shared/app-registry';

type FluentIcon = typeof Globe20Regular;

const ICON_OPTIONS: { name: string; Icon: FluentIcon }[] = [
  { name: 'Globe20Regular', Icon: Globe20Regular },
  { name: 'People20Regular', Icon: People20Regular },
  { name: 'Video20Regular', Icon: Video20Regular },
  { name: 'MusicNote220Regular', Icon: MusicNote220Regular },
  { name: 'News20Regular', Icon: News20Regular },
  { name: 'Star20Regular', Icon: Star20Regular },
  { name: 'SlideLayout20Regular', Icon: SlideLayout20Regular },
  { name: 'PersonBoard20Regular', Icon: PersonBoard20Regular },
];

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  iconGrid: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'border-color, color, background-color',
    transitionDuration: '120ms',
    ':hover': {
      border: `1px solid ${tokens.colorNeutralStroke1}`,
      color: tokens.colorNeutralForeground1,
    },
  },
  iconBtnSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  dockToggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    cursor: 'pointer',
    userSelect: 'none',
  },
});

function isValidUrl(str: string): boolean {
  const trimmed = str.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

type AppFormDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Custom web-app creation form (label, URL, icon, dock scope). Ported from
 * the retired Settings → Apps tab; writes directly to the persisted store's
 * `customApps`, which the rest of the page observes reactively.
 */
export const AppFormDialog = memo(({ open, onClose }: AppFormDialogProps) => {
  const styles = useStyles();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [icon, setIcon] = useState('Globe20Regular');
  const [columnScoped, setColumnScoped] = useState(false);

  useEffect(() => {
    if (open) {
      setLabel('');
      setUrl('');
      setIcon('Globe20Regular');
      setColumnScoped(false);
    }
  }, [open]);

  const isValid = label.trim().length > 0 && isValidUrl(url);

  const handleAdd = () => {
    if (!isValid) {
      return;
    }
    const current = persistedStoreApi.$atom.get().customApps ?? [];
    const maxOrder = current.reduce((max, a) => Math.max(max, a.order), 40);
    const entry: CustomAppEntry = {
      id: uuidv4(),
      label: label.trim(),
      icon,
      url: url.trim(),
      order: maxOrder + 10,
      columnScoped,
    };
    void persistedStoreApi.setKey('customApps', [...current, entry]);
    onClose();
  };

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Add custom app</DialogHeader>
        <DialogBody>
          <div className={styles.form}>
            <FormField label="Label">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Teams" autoFocus />
            </FormField>
            <FormField label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." type="url" />
            </FormField>
            <FormField label="Icon">
              <div className={styles.iconGrid}>
                {ICON_OPTIONS.map(({ name, Icon: Ic }) => (
                  <button
                    key={name}
                    type="button"
                    className={mergeClasses(styles.iconBtn, icon === name && styles.iconBtnSelected)}
                    onClick={() => setIcon(name)}
                    aria-label={name}
                    title={name}
                  >
                    <Ic style={{ width: 20, height: 20 }} />
                  </button>
                ))}
              </div>
            </FormField>
            <FormField label="Show in session dock">
              <label className={styles.dockToggleLabel}>
                <Switch checked={columnScoped} onCheckedChange={setColumnScoped} />
                <span>
                  {columnScoped
                    ? "Available column-scoped — visible in each session's dock."
                    : 'Global only — opens as its own deck column via the app launcher.'}
                </span>
              </label>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} isDisabled={!isValid}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
AppFormDialog.displayName = 'AppFormDialog';
