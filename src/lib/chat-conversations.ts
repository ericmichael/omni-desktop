/**
 * Pure helpers for the chat-conversation history index (`chatConversations`
 * in the store). Closing an activated chat column demotes it to this index
 * instead of destroying it; the Focus sidebar's Recent section lists it and
 * resuming rebuilds a column from the entry. All functions are pure — the
 * caller persists the result and deletes snapshots for pruned entries.
 */

import type { ChatConversation } from '@/shared/types';

/** Recent-list cap. Pruned entries lose their snapshots — keep it generous. */
export const MAX_CHAT_CONVERSATIONS = 50;

/** Display-title cap for the first-message-derived label. */
const TITLE_MAX = 60;

/**
 * Derive a conversation title from the first user message: first non-empty
 * line, truncated with an ellipsis. Falls back to "New chat" for empty input
 * (e.g. a files-only message).
 */
export function conversationTitle(firstMessage: string): string {
  const line = firstMessage
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return 'New chat';
  }
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Insert or update an entry, keeping the list newest-first by
 * ``lastActiveAt``. An update merges over the existing entry so a caller that
 * only knows some fields (e.g. a title-less close) doesn't erase the rest.
 */
export function upsertConversation(
  list: readonly ChatConversation[],
  entry: Partial<ChatConversation> & Pick<ChatConversation, 'sessionId' | 'lastActiveAt'>
): ChatConversation[] {
  const existing = list.find((c) => c.sessionId === entry.sessionId);
  const merged: ChatConversation = {
    title: 'New chat',
    ...existing,
    ...entry,
  };
  const rest = list.filter((c) => c.sessionId !== entry.sessionId);
  return [...rest, merged].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * Cap the list at ``max``, newest-first. Returns the kept list and the pruned
 * entries — the caller must delete the pruned entries' snapshots, or their
 * workspace state leaks on disk forever.
 */
export function pruneConversations(
  list: readonly ChatConversation[],
  max: number = MAX_CHAT_CONVERSATIONS
): { kept: ChatConversation[]; pruned: ChatConversation[] } {
  const sorted = [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return { kept: sorted.slice(0, max), pruned: sorted.slice(max) };
}
