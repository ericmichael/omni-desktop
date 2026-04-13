import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

import { makeStyles, tokens } from '@fluentui/react-components';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  FormField,
  FormSkeleton,
  IconButton,
  Input,
  SectionLabel,
  Textarea,
} from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type { SkillEntry } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  addRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
  },
  addFields: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
  },
  flex1: { flex: '1 1 0' },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flex: '1 1 0',
    minWidth: 0,
  },
  headerContent: { flex: '1 1 0', minWidth: 0 },
  headerName: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
  },
  headerDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  panelBody: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  pathLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    wordBreak: 'break-all',
  },
  monoTextarea: {
    '& textarea': {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase200,
      minHeight: '200px',
    },
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
  saveRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
  },
});

export const SettingsModalSkillsTab = memo(() => {
  const styles = useStyles();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await emitter.invoke('skills:list');
      setSkills(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addSkill = useCallback(async () => {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const description = newDescription.trim();
    if (!name || !description) return;
    await emitter.invoke('skills:create', name, description);
    setNewName('');
    setNewDescription('');
    setExpandedSkill(name);
    await load();
  }, [newName, newDescription, load]);

  const removeSkill = useCallback(
    async (entry: SkillEntry) => {
      await emitter.invoke('skills:remove', entry.path);
      if (expandedSkill === entry.name) setExpandedSkill(null);
      await load();
    },
    [expandedSkill, load]
  );

  const onChangeNewName = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  }, []);

  const onChangeNewDescription = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setNewDescription(e.target.value);
  }, []);

  if (loading) return <FormSkeleton fields={4} />;

  return (
    <div className={styles.root}>
      <SectionLabel>Installed Skills</SectionLabel>

      {skills.length === 0 && (
        <div className={styles.empty}>No skills installed. Add one below.</div>
      )}

      <Accordion
        collapsible
        onToggle={(_e, data) => {
          setExpandedSkill(
            data.openItems.length > 0 ? String(data.openItems[data.openItems.length - 1]) : null
          );
        }}
        openItems={expandedSkill ? [expandedSkill] : []}
      >
        {skills.map((skill) => (
          <SkillRow
            key={skill.path}
            skill={skill}
            onRemove={removeSkill}
            onContentSaved={load}
          />
        ))}
      </Accordion>

      <div className={styles.addRow}>
        <SectionLabel>Add Skill</SectionLabel>
        <div className={styles.addFields}>
          <Input
            type="text"
            value={newName}
            onChange={onChangeNewName}
            placeholder="skill-name"
            mono
            className={styles.flex1}
          />
          <Input
            type="text"
            value={newDescription}
            onChange={onChangeNewDescription}
            placeholder="Short description"
            className={styles.flex1}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={addSkill}
            isDisabled={!newName.trim() || !newDescription.trim()}
          >
            <Add20Regular className={styles.iconMr} />
            Add
          </Button>
        </div>
      </div>
    </div>
  );
});
SettingsModalSkillsTab.displayName = 'SettingsModalSkillsTab';

const SkillRow = memo(
  ({
    skill,
    onRemove,
    onContentSaved,
  }: {
    skill: SkillEntry;
    onRemove: (entry: SkillEntry) => void;
    onContentSaved: () => void;
  }) => {
    const styles = useStyles();
    const [content, setContent] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const loadContent = useCallback(async () => {
      if (loaded) return;
      const text = await emitter.invoke('skills:read', skill.path);
      setContent(text);
      setLoaded(true);
      setDirty(false);
    }, [skill.path, loaded]);

    const onClickRemove = useCallback(() => onRemove(skill), [skill, onRemove]);

    const onChangeContent = useCallback(
      (e: ChangeEvent<HTMLTextAreaElement>) => {
        setContent(e.target.value);
        setDirty(true);
      },
      []
    );

    const save = useCallback(async () => {
      if (!content) return;
      setSaving(true);
      try {
        await emitter.invoke('skills:write-content', skill.path, content);
        setDirty(false);
        onContentSaved();
      } finally {
        setSaving(false);
      }
    }, [skill.path, content, onContentSaved]);

    return (
      <AccordionItem value={skill.name}>
        <AccordionHeader expandIconPosition="end" onClick={loadContent}>
          <div className={styles.headerRow}>
            <div className={styles.headerContent}>
              <div className={styles.headerName}>{skill.name}</div>
              <div className={styles.headerDescription}>{skill.description}</div>
            </div>
            <IconButton
              aria-label="Remove skill"
              icon={<Delete20Regular />}
              size="sm"
              onClick={onClickRemove}
            />
          </div>
        </AccordionHeader>
        <AccordionPanel>
          <div className={styles.panelBody}>
            <div className={styles.pathLabel}>{skill.path}</div>
            <FormField label="SKILL.md">
              <Textarea
                value={content ?? ''}
                onChange={onChangeContent}
                className={styles.monoTextarea}
              />
            </FormField>
            {dirty && (
              <div className={styles.saveRow}>
                <Button size="sm" variant="primary" onClick={save} isDisabled={saving}>
                  {saving ? 'Saving\u2026' : 'Save'}
                </Button>
              </div>
            )}
          </div>
        </AccordionPanel>
      </AccordionItem>
    );
  }
);
SkillRow.displayName = 'SkillRow';
