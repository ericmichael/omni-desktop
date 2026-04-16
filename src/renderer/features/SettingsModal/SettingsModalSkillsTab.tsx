import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownload20Regular, Delete20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button, ConfirmDialog, FormSkeleton, IconButton, SectionLabel, Switch } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type { SkillEntry } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  cardTitle: {
    flex: 1,
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  cardDescription: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
  },
  errorBanner: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

const SKILL_FILE_FILTERS = [{ name: 'Skill packages', extensions: ['skill'] }];

export const SettingsModalSkillsTab = memo(() => {
  const styles = useStyles();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<SkillEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await emitter.invoke('skills:list');
      setSkills(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const installFromFile = useCallback(async () => {
    setError(null);
    const filePath = await emitter.invoke('util:select-file', undefined, SKILL_FILE_FILTERS);
    if (!filePath) return;
    try {
      await emitter.invoke('skills:install', filePath);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to install skill');
    }
  }, [load]);

  const onToggle = useCallback(
    async (name: string, enabled: boolean) => {
      await emitter.invoke('skills:set-enabled', name, enabled);
      await load();
    },
    [load]
  );

  const confirmUninstall = useCallback(async () => {
    if (!uninstallTarget) return;
    setError(null);
    try {
      await emitter.invoke('skills:uninstall', uninstallTarget.name);
      setUninstallTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to uninstall skill');
    }
  }, [uninstallTarget, load]);

  if (loading) return <FormSkeleton fields={4} />;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <SectionLabel>Installed Skills</SectionLabel>
        <Button size="sm" variant="ghost" onClick={installFromFile}>
          <ArrowDownload20Regular style={{ marginRight: 4 }} />
          Install from file
        </Button>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {skills.length === 0 && (
        <div className={styles.empty}>No skills installed. Install a .skill file to get started.</div>
      )}

      {skills.map((skill) => (
        <SkillCard
          key={skill.name}
          skill={skill}
          onToggle={onToggle}
          onUninstall={setUninstallTarget}
        />
      ))}

      <ConfirmDialog
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        onConfirm={confirmUninstall}
        title={`Uninstall "${uninstallTarget?.name}"?`}
        description="This will permanently remove the skill and all its files."
        confirmLabel="Uninstall"
        destructive
      />
    </div>
  );
});
SettingsModalSkillsTab.displayName = 'SettingsModalSkillsTab';

// ---------------------------------------------------------------------------
// Skill Card
// ---------------------------------------------------------------------------

type SkillCardProps = {
  skill: SkillEntry;
  onToggle: (name: string, enabled: boolean) => void;
  onUninstall: (skill: SkillEntry) => void;
};

function formatSource(skill: SkillEntry): string {
  const parts: string[] = [];
  if (skill.version) parts.push(`v${skill.version}`);
  if (skill.source.kind === 'file') {
    parts.push(`Installed from ${skill.source.filename}`);
  } else {
    parts.push('Local');
  }
  return parts.join(' · ');
}

const SkillCard = memo(({ skill, onToggle, onUninstall }: SkillCardProps) => {
  const styles = useStyles();

  const handleToggle = useCallback(
    (checked: boolean) => onToggle(skill.name, checked),
    [skill.name, onToggle]
  );

  const handleUninstall = useCallback(() => onUninstall(skill), [skill, onUninstall]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{skill.name}</span>
        <IconButton
          aria-label="Uninstall skill"
          icon={<Delete20Regular />}
          size="sm"
          onClick={handleUninstall}
        />
        <Switch checked={skill.enabled} onCheckedChange={handleToggle} />
      </div>
      <div className={styles.cardDescription}>{skill.description}</div>
      <div className={styles.cardMeta}>{formatSource(skill)}</div>
    </div>
  );
});
SkillCard.displayName = 'SkillCard';
