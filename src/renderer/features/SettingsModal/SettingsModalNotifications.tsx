import { makeStyles, tokens } from '@fluentui/react-components';
import { Alert20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useState } from 'react';

import { Checkbox, FormField } from '@/renderer/ds';
import { requestNotificationPermission } from '@/renderer/services/agent-attention';
import { persistedStoreApi } from '@/renderer/services/store';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  labelRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  labelIcon: { color: tokens.colorBrandForeground1 },
  hint: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground3,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
  blocked: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorPaletteRedForeground1,
    '@media (min-width: 640px)': { fontSize: tokens.fontSizeBase200 },
  },
});

export const SettingsModalNotifications = memo(() => {
  const styles = useStyles();
  const { notifyOnAgentAttention } = useStore(persistedStoreApi.$atom);
  const [permissionBlocked, setPermissionBlocked] = useState(false);

  const onChange = useCallback(async (checked: boolean) => {
    if (checked) {
      const granted = await requestNotificationPermission();
      setPermissionBlocked(!granted);
      if (!granted) {
        return;
      }
    } else {
      setPermissionBlocked(false);
    }
    void persistedStoreApi.setKey('notifyOnAgentAttention', checked);
  }, []);

  return (
    <div className={styles.root}>
      <FormField
        label={
          <span className={styles.labelRow}>
            <Alert20Filled className={styles.labelIcon} />
            Agent notifications
          </span>
        }
      >
        <Checkbox checked={notifyOnAgentAttention} onCheckedChange={onChange} />
      </FormField>
      <span className={styles.hint}>
        When the app is in the background, get a system notification when an agent finishes or is waiting for your
        approval. Clicking it jumps to that session.
      </span>
      {permissionBlocked && (
        <span className={styles.blocked}>
          Notifications are blocked for this app — allow them in your browser or system settings, then try again.
        </span>
      )}
    </div>
  );
});
SettingsModalNotifications.displayName = 'SettingsModalNotifications';
