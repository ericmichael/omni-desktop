import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MAX_CHAT_CONVERSATIONS } from '@/lib/chat-conversations';
import type { SessionItem } from '@/renderer/omniagents-ui/components/SessionList';
import { loadCanonicalSessionList, threadToSessionSummary } from '@/renderer/omniagents-ui/rpc/canonical-session-list';
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import { ConversationOrganizationClient } from '@/renderer/omniagents-ui/rpc/conversation-organization';

const SEARCH_DEBOUNCE_MS = 200;

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The conversation could not be updated.';
}

/**
 * Owns the canonical conversation sidebar projection. The feature gate is
 * atomic: partial negotiation never exposes mutations or server-side search.
 */
export function useConversationManagement(client: RPCClient, connected: boolean) {
  const organization = useMemo(() => new ConversationOrganizationClient(client), [client]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SessionItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busyThreadIds, setBusyThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchRevision, setSearchRevision] = useState(0);
  const searchRequestRef = useRef(0);

  const supported = connected && client.supportsExperimentalFeature('conversationOrganization');

  const refresh = useCallback(async () => {
    try {
      if (client.supportsExperimentalOperation('list_threads')) {
        setSessions(
          await loadCanonicalSessionList(client, MAX_CHAT_CONVERSATIONS, {
            status: 'active',
            organization,
          })
        );
        return;
      }
      setSessions(await client.listSessions({ limit: MAX_CHAT_CONVERSATIONS }));
    } catch {
      // Session refresh is background recovery. Keep the last good projection
      // instead of replacing the sidebar with an error or an empty list.
    }
  }, [client, organization]);

  useEffect(() => () => organization.dispose(), [organization]);

  useEffect(() => {
    return organization.onThreadUpdated(() => {
      void refresh();
      setSearchRevision((revision) => revision + 1);
    });
  }, [organization, refresh]);

  useEffect(() => {
    if (!connected) {
      searchRequestRef.current += 1;
      setSearching(false);
      return;
    }
    void refresh();
  }, [connected, refresh]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!supported || query.length === 0) {
      searchRequestRef.current += 1;
      setSearchResults(null);
      setSearching(false);
      return;
    }

    const request = ++searchRequestRef.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void organization
        .searchThreads(query, { status: 'active', limit: MAX_CHAT_CONVERSATIONS })
        .then((page) => {
          if (searchRequestRef.current !== request) {
            return;
          }
          setSearchResults(
            page.results.map((result) => ({
              ...threadToSessionSummary(result.thread),
              searchPreview: result.preview,
            }))
          );
          setOperationError(null);
        })
        .catch((error: unknown) => {
          if (searchRequestRef.current !== request) {
            return;
          }
          setSearchResults([]);
          setOperationError(message(error));
        })
        .finally(() => {
          if (searchRequestRef.current === request) {
            setSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [organization, searchQuery, searchRevision, supported]);

  const updateThread = useCallback(
    async (threadId: string, update: { title?: string; pinned?: boolean; status?: 'active' | 'archived' }) => {
      if (!client.supportsExperimentalFeature('conversationOrganization')) {
        return;
      }
      setBusyThreadIds((current) => new Set(current).add(threadId));
      setOperationError(null);
      try {
        const result = await organization.updateThread(threadId, update);
        const summary = threadToSessionSummary(result.thread);
        setSessions((current) =>
          result.thread.status === 'archived'
            ? current.filter((session) => session.id !== threadId)
            : current.map((session) => (session.id === threadId ? summary : session))
        );
        setSearchResults((current) =>
          current === null
            ? null
            : result.thread.status === 'archived'
              ? current.filter((session) => session.id !== threadId)
              : current.map((session) =>
                  session.id === threadId ? { ...summary, searchPreview: session.searchPreview } : session
                )
        );
        await refresh();
        setSearchRevision((revision) => revision + 1);
      } catch (error) {
        setOperationError(message(error));
        throw error;
      } finally {
        setBusyThreadIds((current) => {
          const next = new Set(current);
          next.delete(threadId);
          return next;
        });
      }
    },
    [client, organization, refresh]
  );

  return {
    sessions,
    refreshSessions: refresh,
    managementSupported: supported,
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    busyThreadIds,
    operationError,
    dismissOperationError: () => setOperationError(null),
    renameThread: (threadId: string, title: string) => updateThread(threadId, { title }),
    setThreadPinned: (threadId: string, pinned: boolean) => updateThread(threadId, { pinned }),
    archiveThread: (threadId: string) => updateThread(threadId, { status: 'archived' }),
    restoreThread: (threadId: string) => updateThread(threadId, { status: 'active' }),
  };
}
