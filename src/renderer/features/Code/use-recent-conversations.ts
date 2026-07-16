import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';

import { MAX_CHAT_CONVERSATIONS } from '@/lib/chat-conversations';
import type { SessionItem } from '@/renderer/omniagents-ui/components/SessionList';
import { generateSessionTitle } from '@/renderer/omniagents-ui/lib/utils';
import { getSessionController, onColumnRunEnd } from '@/renderer/services/session-control';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ChatConversation, CodeTab } from '@/shared/types';
import { isChatColumn } from '@/shared/types';

/** How often to re-list sessions while the sidebar is mounted. Controllers
 *  register asynchronously after a column connects, so a one-shot load would
 *  race the first boot. */
const REFRESH_MS = 15_000;

/**
 * Conversation data for the Focus sidebar, from the union of the launcher's
 * own ``chatConversations`` index and, when a chat column is running, the
 * agent server's session listing (the same source the old conversations
 * drawer read — it backfills conversations that predate the index).
 *
 * - ``recent``: closed conversations (open ones excluded) for the Recent list.
 * - ``sessionTitles``: titles for EVERY known conversation, open ones
 *   included — the Open rows' labels, so a resumed or migrated conversation
 *   isn't stuck reading "New chat".
 */
export function useRecentConversations(tabs: CodeTab[]): {
  recent: ChatConversation[];
  sessionTitles: Map<string, string>;
} {
  const store = useStore(persistedStoreApi.$atom);
  const [liveSessions, setLiveSessions] = useState<SessionItem[]>([]);

  const chatTabKey = tabs
    .filter(isChatColumn)
    .map((t) => t.id)
    .join(',');

  useEffect(() => {
    const ids = chatTabKey.split(',').filter(Boolean);
    let cancelled = false;
    const load = async () => {
      for (const id of ids) {
        const controller = getSessionController(id);
        if (!controller?.listSessions) {
          continue;
        }
        try {
          const list = await controller.listSessions();
          if (!cancelled) {
            setLiveSessions(list);
          }
          return;
        } catch {
          // Column mid-restart — try the next chat column.
        }
      }
    };
    void load();
    const interval = setInterval(load, REFRESH_MS);
    // A finished run is the moment a new conversation becomes listable.
    const offRunEnd = onColumnRunEnd(() => void load());
    return () => {
      cancelled = true;
      clearInterval(interval);
      offRunEnd();
    };
  }, [chatTabKey]);

  return useMemo(() => {
    const open = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
    const bySession = new Map<string, ChatConversation>();
    for (const s of liveSessions) {
      if (s.message_count > 0) {
        bySession.set(s.id, {
          sessionId: s.id,
          title: generateSessionTitle(s),
          lastActiveAt: Date.parse(s.created_at) || 0,
        });
      }
    }
    // The launcher index wins on conflicts — it carries resume metadata
    // (profileName) the live listing doesn't know about.
    for (const c of store.chatConversations ?? []) {
      bySession.set(c.sessionId, { ...bySession.get(c.sessionId), ...c });
    }
    const sessionTitles = new Map<string, string>();
    for (const c of bySession.values()) {
      sessionTitles.set(c.sessionId, c.title);
    }
    const recent = [...bySession.values()]
      .filter((c) => !open.has(c.sessionId))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      // Both sources are individually capped, but their union can exceed the
      // cap — keep the displayed list bounded too.
      .slice(0, MAX_CHAT_CONVERSATIONS);
    return { recent, sessionTitles };
  }, [liveSessions, store.chatConversations, tabs]);
}
