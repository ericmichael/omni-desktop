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
 * Styling follows the Tasks panel vocabulary — bgCardAlt container, the
 * custom textSubtle/textPrimary tokens, and the launcher's brand color
 * for emphasis — so the panel feels like part of the same family.
 */
export function QueuedMessages({ items, onCancel }: Props) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="px-3 pt-2">
      <div className="rounded-md border border-bgCardAlt bg-bgCardAlt/60 p-2.5">
        <div className="flex items-center gap-2 text-xs text-textSubtle">
          <span className="font-medium text-textPrimary">Up next</span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-brand">{items.length}</span> queued
          </span>
        </div>
        <ul className="mt-1.5 space-y-1">
          {items.map((item, idx) => (
            <li key={item.id} className="flex items-start gap-2 text-xs leading-5">
              <span className="mt-0.5 w-5 shrink-0 text-right tabular-nums text-textSubtle">{idx + 1}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-textPrimary">{item.content}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 text-textSubtle transition-colors hover:bg-bgCardAlt hover:text-textPrimary"
                onClick={() => onCancel(item.id)}
                aria-label="Cancel queued message"
                title="Cancel"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
