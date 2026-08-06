import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import {
  type ConversationItem,
  type ConversationThread,
  type ConversationTurn,
  decodeConversationItem,
  decodeConversationThread,
  decodeConversationTurn,
} from './conversation';

type OrganizationMethod =
  | 'list_threads'
  | 'search_threads'
  | 'update_thread'
  | 'list_thread_descendants'
  | 'fork_session'
  | 'export_thread'
  | 'purge_threads';

export interface ConversationOrganizationTransport {
  request<Method extends OrganizationMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on<Event extends 'thread_updated'>(event: Event, handler: (payload: RpcNotificationMap[Event]) => void): () => void;
}

export type ThreadOrder = 'asc' | 'desc';
export type ThreadStatus = 'active' | 'archived';
export type ThreadSource = 'recorded' | 'adapter';

export type OrganizationThread = ConversationThread & {
  pinned: boolean;
  metadata: Record<string, unknown>;
  loaded?: boolean;
  active?: boolean;
  pending_attention?: number;
  attention?: Record<string, unknown>;
};

export type ThreadFilters = {
  status?: ThreadStatus;
  pinned?: boolean;
  source?: ThreadSource;
  model?: string;
  parentThreadId?: string;
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
};

export type ThreadPageOptions = ThreadFilters & {
  limit?: number;
  cursor?: string;
  order?: ThreadOrder;
};

export type SearchThreadOptions = ThreadFilters & {
  limit?: number;
  cursor?: string;
};

export type ThreadPage = Record<string, unknown> & {
  threads: OrganizationThread[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
};

export type ThreadSearchHit = Record<string, unknown> & {
  thread_id: string;
  match_count: number;
  match_kind: string;
  item_id: string | null;
  turn_id: string | null;
  seq: number | null;
  preview: string;
  thread: OrganizationThread;
};

export type ThreadSearchPage = Record<string, unknown> & {
  query: string;
  results: ThreadSearchHit[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
};

export type UpdateThreadOptions = {
  /** Generated v1 currently cannot express documented `title: null`; see schema limitations below. */
  title?: string;
  pinned?: boolean;
  status?: ThreadStatus;
  metadata?: Record<string, unknown>;
};

export type UpdateThreadResult = Record<string, unknown> & {
  thread: OrganizationThread;
  changed: string[];
  cascaded_thread_ids: string[];
  inaccessible_descendant_count: number;
};

export type DescendantThread = OrganizationThread & { depth: number };

export type ThreadDescendantsResult = Record<string, unknown> & {
  thread_id: string;
  parent_thread_id: string | null;
  branched_from_item_id: string | null;
  descendants: DescendantThread[];
  max_depth: number;
  truncated: boolean;
};

export type ForkThreadOptions = {
  newSessionId?: string;
  fromItemId?: string;
  fromTurnId?: string;
};

export type ForkThreadResult = Record<string, unknown> & {
  session_id: string;
  new_session_id: string;
  branched_from_item_id: string | null;
};

export type ExportThreadResult = Record<string, unknown> & {
  thread: OrganizationThread;
  turns: ConversationTurn[];
  items: ConversationItem[];
  next_cursor: string | null;
  has_more: boolean;
  turns_truncated: boolean;
  descendant_thread_ids: string[];
  descendants_truncated: boolean;
};

export type PurgeThreadsResult = Record<string, unknown> & {
  purged_thread_ids: string[];
  count: number;
  dry_run: boolean;
};

export type ThreadUpdated = Record<string, unknown> & {
  thread_id: string;
  changed: string[];
  thread: OrganizationThread;
  cascaded_thread_ids: string[];
};

/** Wire/documentation mismatches callers must not work around with invented payloads. */
export const CONVERSATION_ORGANIZATION_SCHEMA_LIMITATIONS = [
  'update_thread documents title:null for clearing a title, but generated UpdateThreadParams only accepts string',
  'thread_updated and Thread carry no revision; cache convergence uses updated_at and refetches after reconnect',
] as const;

export class ConversationOrganizationProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationOrganizationProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationOrganizationProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConversationOrganizationProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ConversationOrganizationProtocolError(`${label} must be a string`);
  }
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConversationOrganizationProtocolError(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConversationOrganizationProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) {
    throw new ConversationOrganizationProtocolError(`${label} must be positive`);
  }
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConversationOrganizationProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConversationOrganizationProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new ConversationOrganizationProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

function cursor(value: unknown, hasMore: boolean, label: string): string | null {
  const parsed = nullableIdentifier(value, `${label}.next_cursor`);
  if (hasMore && parsed === null) {
    throw new ConversationOrganizationProtocolError(`${label}.next_cursor is required while has_more is true`);
  }
  return parsed;
}

function organizationThread(value: unknown, label: string): OrganizationThread {
  const raw = record(value, label);
  const base = decodeConversationThread(raw, label);
  return {
    ...base,
    pinned: raw.pinned === undefined ? false : booleanValue(raw.pinned, `${label}.pinned`),
    metadata: raw.metadata === undefined ? {} : record(raw.metadata, `${label}.metadata`),
    ...(raw.loaded === undefined ? {} : { loaded: booleanValue(raw.loaded, `${label}.loaded`) }),
    ...(raw.active === undefined ? {} : { active: booleanValue(raw.active, `${label}.active`) }),
    ...(raw.pending_attention === undefined
      ? {}
      : { pending_attention: nonNegativeInteger(raw.pending_attention, `${label}.pending_attention`) }),
    ...(raw.attention === undefined ? {} : { attention: record(raw.attention, `${label}.attention`) }),
  };
}

function pageFields(raw: Record<string, unknown>, label: string) {
  const hasMore = booleanValue(raw.has_more, `${label}.has_more`);
  return {
    next_cursor: cursor(raw.next_cursor, hasMore, label),
    has_more: hasMore,
    total: nonNegativeInteger(raw.total, `${label}.total`),
  };
}

function assertThreadOrder(threads: readonly OrganizationThread[], order: ThreadOrder): void {
  for (let index = 1; index < threads.length; index += 1) {
    const previous = threads[index - 1]!;
    const current = threads[index]!;
    const comparison =
      current.updated_at === previous.updated_at
        ? current.thread_id.localeCompare(previous.thread_id)
        : current.updated_at - previous.updated_at;
    if ((order === 'asc' && comparison <= 0) || (order === 'desc' && comparison >= 0)) {
      throw new ConversationOrganizationProtocolError(`list_threads.threads must be strictly ${order} by cursor key`);
    }
  }
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
}

function addFilters(target: Record<string, unknown>, options: ThreadFilters): void {
  if (options.status !== undefined) {
    if (options.status !== 'active' && options.status !== 'archived') {
      throw new TypeError('status must be active or archived');
    }
    target.status = options.status;
  }
  if (options.pinned !== undefined) {
    target.pinned = options.pinned;
  }
  if (options.source !== undefined) {
    if (options.source !== 'recorded' && options.source !== 'adapter') {
      throw new TypeError('source must be recorded or adapter');
    }
    target.source = options.source;
  }
  if (options.model !== undefined) {
    target.model = nonEmptyString(options.model, 'model');
  }
  if (options.parentThreadId !== undefined) {
    target.parent_thread_id = nonEmptyString(options.parentThreadId, 'parentThreadId');
  }
  if (options.createdAfter !== undefined) {
    target.created_after = finiteNumber(options.createdAfter, 'createdAfter');
  }
  if (options.createdBefore !== undefined) {
    target.created_before = finiteNumber(options.createdBefore, 'createdBefore');
  }
  if (options.updatedAfter !== undefined) {
    target.updated_after = finiteNumber(options.updatedAfter, 'updatedAfter');
  }
  if (options.updatedBefore !== undefined) {
    target.updated_before = finiteNumber(options.updatedBefore, 'updatedBefore');
  }
}

function searchHit(value: unknown, label: string): ThreadSearchHit {
  const raw = record(value, label);
  const thread = organizationThread(raw.thread, `${label}.thread`);
  const threadId = nonEmptyString(raw.thread_id, `${label}.thread_id`);
  if (thread.thread_id !== threadId) {
    throw new ConversationOrganizationProtocolError(`${label}.thread has a different thread_id`);
  }
  return {
    ...raw,
    thread_id: threadId,
    match_count: positiveInteger(raw.match_count, `${label}.match_count`),
    match_kind: nonEmptyString(raw.match_kind, `${label}.match_kind`),
    item_id: nullableIdentifier(raw.item_id, `${label}.item_id`),
    turn_id: nullableIdentifier(raw.turn_id, `${label}.turn_id`),
    seq: raw.seq === null ? null : positiveInteger(raw.seq, `${label}.seq`),
    preview: typeof raw.preview === 'string' ? raw.preview : nonEmptyString(raw.preview, `${label}.preview`),
    thread,
  };
}

function threadUpdated(value: unknown): ThreadUpdated {
  const raw = record(value, 'thread_updated');
  const thread = organizationThread(raw.thread, 'thread_updated.thread');
  const threadId = nonEmptyString(raw.thread_id, 'thread_updated.thread_id');
  if (thread.thread_id !== threadId) {
    throw new ConversationOrganizationProtocolError('thread_updated.thread has a different thread_id');
  }
  return {
    ...raw,
    thread_id: threadId,
    changed: stringArray(raw.changed, 'thread_updated.changed'),
    thread,
    cascaded_thread_ids:
      raw.cascaded_thread_ids === undefined
        ? []
        : stringArray(raw.cascaded_thread_ids, 'thread_updated.cascaded_thread_ids'),
  };
}

export class ConversationOrganizationClient {
  private readonly threads = new Map<string, OrganizationThread>();
  private readonly invalidated = new Set<string>();
  private readonly listeners = new Set<(update: ThreadUpdated) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly rpc: ConversationOrganizationTransport) {
    this.unsubscribe = rpc.on('thread_updated', (payload) => {
      const update = threadUpdated(payload);
      if (!this.adopt(update.thread)) {
        return;
      }
      this.invalidate(update.cascaded_thread_ids);
      for (const listener of this.listeners) {
        listener(update);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  onThreadUpdated(listener: (update: ThreadUpdated) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCached(threadId: string): OrganizationThread | undefined {
    return this.threads.get(threadId);
  }

  isInvalidated(threadId: string): boolean {
    return this.invalidated.has(threadId);
  }

  async listThreads(options: ThreadPageOptions = {}): Promise<ThreadPage> {
    const params: Record<string, unknown> = {};
    addFilters(params, options);
    if (options.limit !== undefined) {
      params.limit = safeInteger(options.limit, 'limit');
    }
    if (options.cursor !== undefined) {
      params.cursor = nonEmptyString(options.cursor, 'cursor');
    }
    if (options.order !== undefined) {
      if (options.order !== 'asc' && options.order !== 'desc') {
        throw new TypeError('order must be asc or desc');
      }
      params.order = options.order;
    }
    const raw = record(
      await this.rpc.request('list_threads', params as RpcMethodMap['list_threads']['params']),
      'list_threads'
    );
    const threads = array(raw.threads, organizationThread, 'list_threads.threads');
    assertThreadOrder(threads, options.order ?? 'desc');
    threads.forEach((thread) => this.adopt(thread));
    return { ...raw, threads, ...pageFields(raw, 'list_threads') };
  }

  async searchThreads(query: string, options: SearchThreadOptions = {}): Promise<ThreadSearchPage> {
    // An empty/no-term query has a documented, honest empty result and must
    // reach the server rather than being rejected by the client.
    const params: Record<string, unknown> = { query: stringValue(query, 'query') };
    addFilters(params, options);
    if (options.limit !== undefined) {
      params.limit = safeInteger(options.limit, 'limit');
    }
    if (options.cursor !== undefined) {
      params.cursor = nonEmptyString(options.cursor, 'cursor');
    }
    const raw = record(
      await this.rpc.request('search_threads', params as unknown as RpcMethodMap['search_threads']['params']),
      'search_threads'
    );
    const echoedQuery = stringValue(raw.query, 'search_threads.query');
    if (echoedQuery !== query) {
      throw new ConversationOrganizationProtocolError('search_threads returned a different query');
    }
    const results = array(raw.results, searchHit, 'search_threads.results');
    results.forEach((result) => this.adopt(result.thread));
    return { ...raw, query: echoedQuery, results, ...pageFields(raw, 'search_threads') };
  }

  async updateThread(threadId: string, options: UpdateThreadOptions): Promise<UpdateThreadResult> {
    if (options.title !== undefined) {
      stringValue(options.title, 'title');
    }
    if (options.pinned !== undefined) {
      booleanValue(options.pinned, 'pinned');
    }
    if (options.status !== undefined && options.status !== 'active' && options.status !== 'archived') {
      throw new TypeError('status must be active or archived');
    }
    if (options.metadata !== undefined) {
      record(options.metadata, 'metadata');
    }
    const params: RpcMethodMap['update_thread']['params'] = {
      thread_id: nonEmptyString(threadId, 'threadId'),
      ...options,
    };
    const raw = record(await this.rpc.request('update_thread', params), 'update_thread');
    const thread = organizationThread(raw.thread, 'update_thread.thread');
    if (thread.thread_id !== params.thread_id) {
      throw new ConversationOrganizationProtocolError('update_thread returned a different thread_id');
    }
    const result: UpdateThreadResult = {
      ...raw,
      thread,
      changed: stringArray(raw.changed, 'update_thread.changed'),
      cascaded_thread_ids: stringArray(raw.cascaded_thread_ids, 'update_thread.cascaded_thread_ids'),
      inaccessible_descendant_count: nonNegativeInteger(
        raw.inaccessible_descendant_count,
        'update_thread.inaccessible_descendant_count'
      ),
    };
    this.adopt(thread);
    this.invalidate(result.cascaded_thread_ids);
    return result;
  }

  async listThreadDescendants(
    threadId: string,
    options: { maxDepth?: number; limit?: number } = {}
  ): Promise<ThreadDescendantsResult> {
    const params: RpcMethodMap['list_thread_descendants']['params'] = {
      thread_id: nonEmptyString(threadId, 'threadId'),
    };
    if (options.maxDepth !== undefined) {
      params.max_depth = safeInteger(options.maxDepth, 'maxDepth');
    }
    if (options.limit !== undefined) {
      params.limit = safeInteger(options.limit, 'limit');
    }
    const raw = record(await this.rpc.request('list_thread_descendants', params), 'list_thread_descendants');
    const resultThreadId = nonEmptyString(raw.thread_id, 'list_thread_descendants.thread_id');
    if (resultThreadId !== params.thread_id) {
      throw new ConversationOrganizationProtocolError('list_thread_descendants returned a different thread_id');
    }
    const descendants = array(
      raw.descendants,
      (entry, label) => ({
        ...organizationThread(entry, label),
        depth: positiveInteger(record(entry, label).depth, `${label}.depth`),
      }),
      'list_thread_descendants.descendants'
    );
    descendants.forEach((thread) => this.adopt(thread));
    return {
      ...raw,
      thread_id: resultThreadId,
      parent_thread_id: nullableIdentifier(raw.parent_thread_id, 'list_thread_descendants.parent_thread_id'),
      branched_from_item_id: nullableIdentifier(
        raw.branched_from_item_id,
        'list_thread_descendants.branched_from_item_id'
      ),
      descendants,
      max_depth: positiveInteger(raw.max_depth, 'list_thread_descendants.max_depth'),
      truncated: booleanValue(raw.truncated, 'list_thread_descendants.truncated'),
    };
  }

  async forkSession(sessionId: string, options: ForkThreadOptions = {}): Promise<ForkThreadResult> {
    if (options.fromItemId !== undefined && options.fromTurnId !== undefined) {
      throw new TypeError('forkSession accepts either fromItemId or fromTurnId, not both');
    }
    const params: RpcMethodMap['fork_session']['params'] = {
      session_id: nonEmptyString(sessionId, 'sessionId'),
      ...(options.newSessionId === undefined
        ? {}
        : { new_session_id: nonEmptyString(options.newSessionId, 'newSessionId') }),
      ...(options.fromItemId === undefined ? {} : { from_item_id: nonEmptyString(options.fromItemId, 'fromItemId') }),
      ...(options.fromTurnId === undefined ? {} : { from_turn_id: nonEmptyString(options.fromTurnId, 'fromTurnId') }),
    };
    const raw = record(await this.rpc.request('fork_session', params), 'fork_session');
    const result: ForkThreadResult = {
      ...raw,
      session_id: nonEmptyString(raw.session_id, 'fork_session.session_id'),
      new_session_id: nonEmptyString(raw.new_session_id, 'fork_session.new_session_id'),
      branched_from_item_id: nullableIdentifier(raw.branched_from_item_id, 'fork_session.branched_from_item_id'),
    };
    if (result.session_id !== params.session_id) {
      throw new ConversationOrganizationProtocolError('fork_session returned a different session_id');
    }
    if (params.new_session_id !== undefined && result.new_session_id !== params.new_session_id) {
      throw new ConversationOrganizationProtocolError('fork_session returned a different new_session_id');
    }
    return result;
  }

  async exportThread(
    threadId: string,
    options: { limit?: number; cursor?: string; includeDescendants?: boolean } = {}
  ): Promise<ExportThreadResult> {
    const params: RpcMethodMap['export_thread']['params'] = { thread_id: nonEmptyString(threadId, 'threadId') };
    if (options.limit !== undefined) {
      params.limit = safeInteger(options.limit, 'limit');
    }
    if (options.cursor !== undefined) {
      params.cursor = nonEmptyString(options.cursor, 'cursor');
    }
    if (options.includeDescendants !== undefined) {
      params.include_descendants = booleanValue(options.includeDescendants, 'includeDescendants');
    }
    const raw = record(await this.rpc.request('export_thread', params), 'export_thread');
    const thread = organizationThread(raw.thread, 'export_thread.thread');
    if (thread.thread_id !== params.thread_id) {
      throw new ConversationOrganizationProtocolError('export_thread returned a different thread_id');
    }
    const turns = array(raw.turns, decodeConversationTurn, 'export_thread.turns');
    const items = array(raw.items, decodeConversationItem, 'export_thread.items');
    if (
      turns.some((turn) => turn.thread_id !== params.thread_id) ||
      items.some((item) => item.thread_id !== params.thread_id)
    ) {
      throw new ConversationOrganizationProtocolError('export_thread returned canonical rows for another thread');
    }
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]!.seq <= items[index - 1]!.seq) {
        throw new ConversationOrganizationProtocolError('export_thread.items must preserve ascending cursor order');
      }
    }
    const hasMore = booleanValue(raw.has_more, 'export_thread.has_more');
    this.adopt(thread);
    return {
      ...raw,
      thread,
      turns,
      items,
      next_cursor: cursor(raw.next_cursor, hasMore, 'export_thread'),
      has_more: hasMore,
      turns_truncated: booleanValue(raw.turns_truncated, 'export_thread.turns_truncated'),
      descendant_thread_ids: stringArray(raw.descendant_thread_ids, 'export_thread.descendant_thread_ids'),
      descendants_truncated: booleanValue(raw.descendants_truncated, 'export_thread.descendants_truncated'),
    };
  }

  async purgeThreads(retentionDays: number, dryRun?: boolean): Promise<PurgeThreadsResult> {
    const params: RpcMethodMap['purge_threads']['params'] = {
      retention_days: safeInteger(retentionDays, 'retentionDays'),
    };
    if (dryRun !== undefined) {
      params.dry_run = booleanValue(dryRun, 'dryRun');
    }
    const raw = record(await this.rpc.request('purge_threads', params), 'purge_threads');
    const purged = stringArray(raw.purged_thread_ids, 'purge_threads.purged_thread_ids');
    const count = nonNegativeInteger(raw.count, 'purge_threads.count');
    if (count !== purged.length) {
      throw new ConversationOrganizationProtocolError('purge_threads.count must match purged_thread_ids.length');
    }
    if (raw.dry_run !== Boolean(dryRun)) {
      throw new ConversationOrganizationProtocolError('purge_threads returned a different dry_run value');
    }
    if (!raw.dry_run) {
      this.invalidate(purged);
    }
    return { ...raw, purged_thread_ids: purged, count, dry_run: booleanValue(raw.dry_run, 'purge_threads.dry_run') };
  }

  private adopt(thread: OrganizationThread): boolean {
    const current = this.threads.get(thread.thread_id);
    // The schema has no thread revision. updated_at is the strongest monotonic
    // value available; equal timestamps are treated as duplicate delivery.
    if (current && thread.updated_at <= current.updated_at) {
      return false;
    }
    this.threads.set(thread.thread_id, thread);
    this.invalidated.delete(thread.thread_id);
    return true;
  }

  private invalidate(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      this.threads.delete(threadId);
      this.invalidated.add(threadId);
    }
  }
}
