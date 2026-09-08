/**
 * Stable React identity for transcript rows.
 *
 * The list was keyed by array position, which is only correct while items
 * are strictly appended. They aren't: a live voice session re-sorts its
 * transcript into the model's item order when the user's async
 * transcription lands, and the host interleaves two streams into one list.
 * Position-keyed rows then get reused for a different item — a tool card
 * keeps another card's expansion, a reaction moves to the wrong message.
 *
 * Identity comes from the item itself wherever it exists: the canonical
 * envelope first (the server's own id, which every reload agrees on), then
 * the id the item type carries. Rows that genuinely have no id — a live
 * assistant message mid-run — fall back to position, which is no worse than
 * before and settles as soon as the canonical reload gives them one.
 */
import type { ActivityGroupData, DisplayItem } from './activity-group';

/** Position-derived last resort; typed so it can never collide with an id. */
function positional(type: string, index: number): string {
  return `at:${index}:${type}`;
}

export function messageKey(item: DisplayItem, index: number): string {
  if (item.type === 'activity_group') {
    // A group is a view over its members — borrow the first one's identity so
    // the block survives items being appended to it.
    const first = (item as ActivityGroupData).items[0];
    return `group:${first ? messageKey(first, index) : `${(item as ActivityGroupData).runId ?? 'machinery'}:${index}`}`;
  }

  const canonical = item.canonical?.item_id;
  if (canonical) {
    return `canonical:${canonical}`;
  }

  switch (item.type) {
    case 'chat':
      return item.item_id ? `chat:${item.item_id}` : positional(item.type, index);
    case 'tool':
      return item.call_id
        ? item.runId
          ? `tool:${JSON.stringify([item.runId, item.call_id])}`
          : `tool:${item.call_id}`
        : positional(item.type, index);
    case 'approval':
      return `approval:${item.request_id}`;
    case 'guardian_review':
      return `guardian:${item.request_id}`;
    case 'workflow_review':
      // A step can be reviewed more than once; the outcome distinguishes them
      // (the same pair the session machine dedupes on).
      return `workflow:${item.task_id}:${item.outcome}`;
    case 'plan':
      return `plan:${item.id}`;
    case 'artifact':
      return item.artifact_id ? `artifact:${item.artifact_id}` : positional(item.type, index);
    case 'run_diff':
      return `run_diff:${item.id}`;
    default:
      return positional(item.type, index);
  }
}
