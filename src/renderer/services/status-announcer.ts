/**
 * Pure announcement builder for the screen-reader status center (UI/UX
 * gameplan Phase 10). One polite live region at the App root announces column
 * transitions instead of every column being its own `role="status"` — five
 * working columns used to produce five interleaved narration streams.
 *
 * Announces the same transitions the system notifications use: a column
 * starting to wait for approval, and a run finishing. Working-start is
 * deliberately silent (it's noise at deck scale).
 */
import type { ColumnActivity } from '@/renderer/services/column-activity';

export function buildAnnouncements(
  prev: Record<string, ColumnActivity>,
  next: Record<string, ColumnActivity>,
  labelFor: (scope: string) => string
): string[] {
  const messages: string[] = [];
  for (const [scope, activity] of Object.entries(next)) {
    if (!activity) {
      continue;
    }
    const before = prev[scope];
    if (activity.pendingApproval && !before?.pendingApproval) {
      messages.push(`${labelFor(scope)}: waiting for your approval`);
    } else if (before?.thinking && !activity.thinking && !activity.pendingApproval) {
      messages.push(`${labelFor(scope)}: finished`);
    }
  }
  return messages;
}
