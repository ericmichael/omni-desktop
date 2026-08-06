import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import { isCanonicalConversationUnsupported } from '@/renderer/omniagents-ui/rpc/canonical-chat-history';
import {
  ConversationOrganizationClient,
  type OrganizationThread,
  type ThreadStatus,
} from '@/renderer/omniagents-ui/rpc/conversation-organization';

export type CanonicalSessionSummary = {
  id: string;
  created_at: string;
  archived: boolean;
  message_count: number;
  title?: string;
  pinned?: boolean;
  searchPreview?: string;
  first_message?: unknown;
  last_message?: unknown;
};

type CanonicalSessionListMethod =
  | 'get_thread'
  | 'list_threads'
  | 'search_threads'
  | 'update_thread'
  | 'list_thread_descendants'
  | 'fork_session'
  | 'export_thread'
  | 'purge_threads';

export interface CanonicalSessionListTransport {
  request<Method extends CanonicalSessionListMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on<Event extends 'thread_updated'>(
    event: Event,
    handler: (payload: import('@/generated/omniagents-gui-v1/gui-v1').RpcNotificationMap[Event]) => void
  ): () => void;
  listSessions(options?: { limit?: number }): Promise<CanonicalSessionSummary[]>;
}

function timestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Preserve the current sidebar contract while making canonical threads authoritative. */
export function threadToSessionSummary(thread: OrganizationThread): CanonicalSessionSummary {
  return {
    id: thread.thread_id,
    created_at: timestamp(thread.created_at),
    archived: thread.status === 'archived',
    message_count: thread.item_count,
    ...(thread.title ? { title: thread.title } : {}),
    pinned: thread.pinned,
    ...(thread.title ? { first_message: { content: thread.title } } : {}),
    last_message: { timestamp: timestamp(thread.updated_at) },
  };
}

/**
 * Load the v2 thread projection without hiding pre-v2 sessions. `list_threads`
 * deliberately omits legacy rows until `get_thread` lazily materializes them,
 * so the bounded legacy enumeration is part of the compatibility read rather
 * than an error-only fallback. Any row that cannot be materialized remains in
 * the merged result; canonical identity wins as soon as it exists.
 */
export async function loadCanonicalSessionList(
  transport: CanonicalSessionListTransport,
  limit: number,
  options: {
    status?: ThreadStatus;
    organization?: ConversationOrganizationClient;
  } = {}
): Promise<CanonicalSessionSummary[]> {
  const organization = options.organization ?? new ConversationOrganizationClient(transport);
  const ownsOrganization = options.organization === undefined;
  const legacy = (await transport.listSessions({ limit })).filter((session) =>
    options.status === 'archived' ? session.archived : options.status === 'active' ? !session.archived : true
  );
  try {
    const listOptions = {
      ...(options.status ? { status: options.status } : {}),
      limit,
      order: 'desc',
    } as const;
    let page = await organization.listThreads(listOptions);
    const existingIds = new Set(page.threads.map((thread) => thread.thread_id));
    const missing = legacy.filter((session) => !existingIds.has(session.id));
    if (missing.length > 0) {
      // Bounded by the same sidebar limit. Only rows absent from the canonical
      // page need lazy projection; failures remain as legacy rows below.
      const materialized = await Promise.allSettled(
        missing.map((session) => transport.request('get_thread', { thread_id: session.id }))
      );
      if (materialized.some((result) => result.status === 'fulfilled')) {
        try {
          page = await organization.listThreads(listOptions);
        } catch {
          // The first canonical page plus the legacy merge is still a complete,
          // safe projection for this refresh. A later refresh will converge.
        }
      }
    }
    const canonical = page.threads.map(threadToSessionSummary);
    const canonicalIds = new Set(canonical.map((session) => session.id));
    return [...canonical, ...legacy.filter((session) => !canonicalIds.has(session.id))].slice(0, limit);
  } catch (error) {
    if (!isCanonicalConversationUnsupported(error)) {
      throw error;
    }
    return legacy;
  } finally {
    if (ownsOrganization) {
      organization.dispose();
    }
  }
}
