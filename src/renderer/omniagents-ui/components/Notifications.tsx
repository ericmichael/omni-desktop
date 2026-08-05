import React from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';

export type NotificationInfo = {
  id: string;
  message: string;
  timestamp: number;
};

type Props = {
  notifications: NotificationInfo[];
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
};

// Docked notifications panel. Accumulates ``notify`` calls from the
// agent and persists them until the user explicitly dismisses them —
// long-running runs can drop many heads-ups; the user catches up at a
// glance and decides what to clear. Mirrors Tasks / BashJobs styling
// (same semantic card surface and primary-color accents).
export function Notifications({ notifications, onDismiss, onDismissAll }: Props) {
  if (!notifications || notifications.length === 0) {
    return null;
  }

  const noun = notifications.length === 1 ? 'notification' : 'notifications';

  return (
    <div className="px-3 pt-2">
      <Card className="gap-0 rounded-md border-accent bg-accent/60 p-2.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Notifications</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-primary">{notifications.length}</span> {noun}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onDismissAll}
            className="ml-auto"
            title="Dismiss all notifications"
          >
            dismiss all
          </Button>
        </div>
        <ul className="mt-1.5 space-y-1">
          {notifications.map((n) => (
            <li key={n.id} className="flex items-start gap-2 text-xs leading-5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-1.5" aria-hidden />
              <span className="min-w-0 flex-1 text-foreground">{n.message}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onDismiss(n.id)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title="Dismiss"
                aria-label="Dismiss notification"
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
