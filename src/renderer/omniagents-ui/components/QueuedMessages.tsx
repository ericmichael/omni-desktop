import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import type { QueuedMessage } from '@/renderer/omniagents-ui/rpc/client';

type Props = {
  items: QueuedMessage[];
  onCancel: (itemId: string) => void;
};

/**
 * "Up next" panel rendered above the chat input. Lists the user's own
 * messages that are waiting for the active run to finish, with a cancel
 * affordance per row.
 *
 * The session queue also carries backend work (batched worker/job
 * notifications, goal and wakeup ticks). Those are not the user's messages
 * and are not shown here.
 *
 * Items disappear from the panel when the user cancels them or the drainer
 * pops them to fire start_run; both paths broadcast queue_changed which
 * replaces this list.
 */
export function QueuedMessages({ items, onCancel }: Props) {
  const own = items.filter((item) => item.role === 'user' && (item.source === null || item.source === 'ui'));
  if (own.length === 0) {
    return null;
  }
  return (
    <div className="px-3 pt-2">
      <Card className="gap-2 py-3">
        <CardHeader className="gap-1 px-3">
          <CardTitle>Up next</CardTitle>
          <CardDescription>{own.length} queued</CardDescription>
        </CardHeader>
        <CardContent className="px-3">
          <ul className="flex flex-col gap-2">
            {own.map((item, idx) => (
              <li key={item.id} className="flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 w-5 shrink-0 text-right tabular-nums text-muted-foreground">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  {item.state === 'failed' && (
                    <p className="mt-1 text-destructive">Not started{item.error ? `: ${item.error}` : ''}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  onClick={() => onCancel(item.id)}
                  aria-label="Cancel queued message"
                  title="Cancel"
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
