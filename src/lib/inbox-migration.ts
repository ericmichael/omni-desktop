import type { InboxItem, InboxItemStatus } from '@/shared/types';

/**
 * Pure helpers that upgrade legacy inbox records to the new-model `InboxItem`.
 *
 * Legacy shape (pre-refactor):
 *   { id, title, description?, status: 'open'|'done'|'deferred'|'iceboxed',
 *     shaping?: { doneLooksLike, appetite: 'small'|'medium'|'large', outOfScope },
 *     projectId?, linkedMilestoneId?, linkedTicketIds?, createdAt, updatedAt }
 *
 * New shape: see `InboxItem` in shared/types. Key differences:
 *   - status collapses to new|later (done is dropped, iceboxed→later)
 *   - legacy shaping blocks are folded into the note as plain text
 *   - laterAt drives expiry
 *   - promotedTo is a tombstone set on ticket/project conversion (not inferred from legacy)
 *
 * Kept pure (no fs, no store) so the migration step can test the mapping
 * exhaustively without bringing up a real store.
 */

/** Map legacy InboxItemStatus to new InboxItemStatus. Returns null for statuses that should be dropped. */
export function mapLegacyStatus(raw: unknown): InboxItemStatus | null {
  if (raw === 'done') {
return null;
} // dropped — terminal completion without a promotion target
  if (raw === 'deferred' || raw === 'iceboxed') {
return 'later';
}
  return 'new'; // default for 'open' and anything unrecognized
}

/**
 * Render a legacy shaping block as plain note text, or undefined when there
 * is nothing meaningful to carry forward. Structured shaping no longer
 * exists — the description/note is the single channel both humans and the
 * agent read.
 */
export function legacyShapingToNoteText(rawShaping: unknown): string | undefined {
  if (!rawShaping || typeof rawShaping !== 'object') {
return undefined;
}
  const s = rawShaping as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof s.doneLooksLike === 'string' && s.doneLooksLike.trim()) {
    lines.push(`**Done when:** ${s.doneLooksLike.trim()}`);
  }
  if (typeof s.outOfScope === 'string' && s.outOfScope.trim()) {
    lines.push(`**Out of scope:** ${s.outOfScope.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Upgrade a single legacy inbox record. Returns `null` when the legacy item
 * should be dropped (status === 'done').
 *
 * `idGen` is injected so callers can mint deterministic IDs under test.
 */
export function upgradeLegacyInboxItem(
  raw: Record<string, unknown>,
  now: number,
  idGen: () => string
): InboxItem | null {
  const status = mapLegacyStatus(raw.status);
  if (status === null) {
return null;
}

  const title =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Untitled';
  const description = typeof raw.description === 'string' && raw.description.trim()
    ? raw.description.trim()
    : undefined;
  const shapingText = legacyShapingToNoteText(raw.shaping);
  const note = [description, shapingText].filter(Boolean).join('\n\n') || undefined;
  const projectId =
    typeof raw.projectId === 'string' && raw.projectId.length > 0 ? raw.projectId : null;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : now;

  const item: InboxItem = {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : idGen(),
    title,
    status,
    projectId,
    createdAt,
    updatedAt,
  };
  if (note) {
item.note = note;
}
  if (status === 'later') {
    item.laterAt = updatedAt;
  }
  if (Array.isArray(raw.attachments) && raw.attachments.every((a) => typeof a === 'string')) {
    item.attachments = raw.attachments as string[];
  }
  return item;
}

/**
 * Upgrade a batch of legacy inbox records, dropping any whose status mapping
 * returns null. Order is preserved.
 */
export function upgradeLegacyInbox(
  rawItems: Array<Record<string, unknown>>,
  now: number,
  idGen: () => string
): InboxItem[] {
  const upgraded: InboxItem[] = [];
  for (const raw of rawItems) {
    const item = upgradeLegacyInboxItem(raw, now, idGen);
    if (item) {
upgraded.push(item);
}
  }
  return upgraded;
}
