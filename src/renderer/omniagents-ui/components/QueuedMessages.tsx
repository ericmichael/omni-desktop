import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import type { QueuedMessage } from '@/renderer/omniagents-ui/rpc/client';

type Props = {
  items: QueuedMessage[];
  onCancel: (itemId: string) => void;
};

/**
 * "Up next" panel rendered above the chat input. Lists user messages that
 * have been enqueued while a run is active (or while earlier queued items
 * are pending), with a cancel affordance per row.
 *
 * Items disappear from the panel when:
 *   - the user cancels them via the × button (server returns ok=true)
 *   - the drainer pops them to actually fire start_run
 *   (both paths broadcast queue_changed which replaces this list)
 *
 * Styling follows the Tasks panel vocabulary — a semantic card container,
 * muted/foreground text, and the active theme's primary color
 * for emphasis — so the panel feels like part of the same family.
 */
export function QueuedMessages({ items, onCancel }: Props) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="px-3 pt-2">
      <Card className="gap-2 py-3">
        <CardHeader className="gap-1 px-3">
          <CardTitle>Up next</CardTitle>
          <CardDescription>{items.length} queued</CardDescription>
        </CardHeader>
        <CardContent className="px-3">
          <ul className="flex flex-col gap-2">
            {items.map((item, idx) => (
              <li key={item.id} className="flex items-start gap-2 text-xs leading-5">
                <span className="mt-0.5 w-5 shrink-0 text-right tabular-nums text-muted-foreground">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  {item.state === 'pending' && item.error && (
                    <Alert className="mt-2">
                      <AlertDescription>{item.error}</AlertDescription>
                    </Alert>
                  )}
                  {item.state === 'dispatch_uncertain' && (
                    <Alert className="mt-2">
                      <AlertDescription>
                        Dispatch outcome unknown. This message will not be sent again automatically. Later queued
                        messages are paused.
                      </AlertDescription>
                    </Alert>
                  )}
                  {item.state === 'failed' && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertDescription>Not started: {item.error ?? 'The run was rejected.'}</AlertDescription>
                    </Alert>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={item.state === 'dispatch_uncertain'}
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
