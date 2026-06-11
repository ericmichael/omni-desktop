import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Dismiss20Regular, WindowConsole20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button, Caption1, IconButton } from '@/renderer/ds';
import { emitter, isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    width: '100%',
    maxWidth: '860px',
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', `color-mix(in srgb, ${tokens.colorNeutralStroke1} 58%, transparent)`),
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground1} 86%, transparent)`,
    marginTop: tokens.spacingVerticalM,
  },
  icon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  error: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
});

/**
 * Contextual home of the CLI install (formerly the last onboarding step):
 * developers meet it the first time they open Spaces; everyday users who
 * never come here never see a PATH symlink. Dismissal persists.
 */
export const CliInstallCard = memo(() => {
  const styles = useStyles();
  const dismissed = useStore(persistedStoreApi.$atom).cliCardDismissed;
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligible = isElectron && !dismissed;

  useEffect(() => {
    if (!eligible) {
      return;
    }
    void emitter.invoke('util:get-cli-in-path-status').then((status) => setInstalled(status.installed));
  }, [eligible]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      const result = await emitter.invoke('util:install-cli-to-path');
      if (result.success) {
        setInstalled(true);
      } else {
        setError(result.error);
      }
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    void persistedStoreApi.setKey('cliCardDismissed', true);
  }, []);

  if (!eligible || installed !== false) {
    return null;
  }

  return (
    <div className={styles.card}>
      <WindowConsole20Regular className={styles.icon} />
      <div className={styles.body}>
        <span className={styles.title}>Use Omni from your terminal</span>
        <Caption1 className={error ? styles.error : undefined}>
          {error ?? 'Install the omni command to run the same coding agent in any shell.'}
        </Caption1>
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={handleInstall} isDisabled={installing}>
          {installing ? 'Installing…' : 'Install'}
        </Button>
        <IconButton aria-label="Dismiss" icon={<Dismiss20Regular />} size="sm" onClick={handleDismiss} />
      </div>
    </div>
  );
});
CliInstallCard.displayName = 'CliInstallCard';
