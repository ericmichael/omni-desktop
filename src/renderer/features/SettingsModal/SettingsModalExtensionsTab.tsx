import { makeStyles, tokens } from '@fluentui/react-components';
import { PuzzlePiece20Filled } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import { Switch } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type { ExtensionDescriptor } from '@/shared/extensions';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  title: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flex: 1, fontWeight: 600 },
  icon: { color: tokens.colorBrandForeground1 },
  description: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  contentTypes: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS,
  },
  chip: {
    fontSize: tokens.fontSizeBase100,
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
  },
});

export const SettingsModalExtensionsTab = memo(() => {
  const styles = useStyles();
  const [descriptors, setDescriptors] = useState<ExtensionDescriptor[] | null>(null);

  const refresh = useCallback(async () => {
    const list = await emitter.invoke('extension:list-descriptors');
    setDescriptors(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(
    async (id: string, enabled: boolean) => {
      await emitter.invoke('extension:set-enabled', id, enabled);
      await refresh();
    },
    [refresh]
  );

  if (descriptors === null) {
    return <div className={styles.empty}>Loading…</div>;
  }
  if (descriptors.length === 0) {
    return <div className={styles.empty}>No extensions available.</div>;
  }

  return (
    <div className={styles.root}>
      {descriptors.map((ext) => (
        <ExtensionCard key={ext.id} ext={ext} onToggle={onToggle} />
      ))}
    </div>
  );
});
SettingsModalExtensionsTab.displayName = 'SettingsModalExtensionsTab';

type ExtensionCardProps = {
  ext: ExtensionDescriptor;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
};

const ExtensionCard = memo(({ ext, onToggle }: ExtensionCardProps) => {
  const styles = useStyles();
  const handleChange = useCallback(
    (checked: boolean) => {
      void onToggle(ext.id, checked);
    },
    [ext.id, onToggle]
  );
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>
          <PuzzlePiece20Filled className={styles.icon} />
          {ext.name}
        </div>
        <Switch checked={ext.enabled} onCheckedChange={handleChange} />
      </div>
      <div className={styles.description}>{ext.description}</div>
      {ext.contentTypes.length > 0 && (
        <div className={styles.contentTypes}>
          {ext.contentTypes.map((ct) => (
            <span key={ct.id} className={styles.chip}>
              {ct.label} ({ct.fileExtension})
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
ExtensionCard.displayName = 'ExtensionCard';
