import { useStore } from '@nanostores/react';
import { TriangleAlert } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Field, FieldLabel } from '@/renderer/ds/ui/field';
import { requestNotificationPermission } from '@/renderer/services/agent-attention';
import { persistedStoreApi } from '@/renderer/services/store';

export const SettingsModalNotifications = memo(() => {
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
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal" className="justify-between gap-4">
        <div className="min-w-0">
          <FieldLabel>
            <span className="flex items-center gap-2">
              <TriangleAlert className="text-primary" />
              Agent notifications
            </span>
          </FieldLabel>
        </div>
        <Checkbox checked={notifyOnAgentAttention} onCheckedChange={(checked) => onChange(checked === true)} />
      </Field>
      <span className="text-sm text-muted-foreground sm:text-xs">
        When the app is in the background, get a system notification when an agent finishes or is waiting for your
        approval. Clicking it jumps to that session.
      </span>
      {permissionBlocked && (
        <span className="text-sm text-destructive sm:text-xs">
          Notifications are blocked for this app — allow them in your browser or system settings, then try again.
        </span>
      )}
    </div>
  );
});
SettingsModalNotifications.displayName = 'SettingsModalNotifications';
