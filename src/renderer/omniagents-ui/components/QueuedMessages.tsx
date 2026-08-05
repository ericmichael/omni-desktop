import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';
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
      <Card className="gap-0 rounded-md border-accent bg-accent/60 p-2.5 shadow-none">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Up next</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-primary">{items.length}</span> queued
          </span>
        </div>
        <ul className="mt-1.5 space-y-1">
          {items.map((item, idx) => (
            <li key={item.id} className="flex items-start gap-2 text-xs leading-5">
              <span className="mt-0.5 w-5 shrink-0 text-right tabular-nums text-muted-foreground">{idx + 1}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{item.content}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground"
                onClick={() => onCancel(item.id)}
                aria-label="Cancel queued message"
                title="Cancel"
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
