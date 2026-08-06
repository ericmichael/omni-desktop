import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

type ConversationMethod = Extract<keyof RpcMethodMap, 'get_thread' | 'list_turns' | 'list_items' | 'get_item'>;

export interface ConversationRpcTransport {
  request<Method extends ConversationMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
}

export type ConversationThreadStatus = 'active' | 'archived';
export type ConversationTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ConversationItemStatus = 'started' | 'completed' | 'failed' | 'cancelled';
export type KnownConversationItemKind =
  | 'user_message'
  | 'agent_message'
  | 'reasoning'
  | 'tool_call'
  | 'approval'
  | 'elicitation'
  | 'artifact'
  | 'compaction'
  | 'plan'
  | 'run_diff';

/** Known values receive autocomplete while newer server-defined kinds remain renderable. */
export type ConversationItemKind = KnownConversationItemKind | (string & {});
export type ConversationOrder = 'asc' | 'desc';

/**
 * Results are open records by protocol design. Required canonical fields are
 * validated and normalized, while additive fields survive unchanged.
 */
export type ConversationThread = Record<string, unknown> & {
  thread_id: string;
  user_id: string | null;
  status: ConversationThreadStatus;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_seq: number;
  turn_count: number;
  item_count: number;
  parent_thread_id: string | null;
  branched_from_item_id: string | null;
  usage: Record<string, unknown>;
  compaction: Record<string, unknown>;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
  source: string;
  projected_at: number | null;
  schema_version: number;
};

export type ConversationTurn = Record<string, unknown> & {
  turn_id: string;
  thread_id: string;
  ordinal: number;
  status: ConversationTurnStatus;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  prompt: string | null;
  prompt_role: string | null;
  end_reason: string | null;
  error: Record<string, unknown> | null;
  usage: Record<string, unknown>;
  model: string | null;
  model_ref: string | null;
  item_count: number;
  first_seq: number | null;
  last_seq: number | null;
  attempts: number;
  source: string;
  schema_version: number;
};

export type ConversationItem = Record<string, unknown> & {
  item_id: string;
  thread_id: string;
  turn_id: string | null;
  /** Thread-monotonic ordinal and the only supported transcript ordering key. */
  seq: number;
  kind: ConversationItemKind;
  status: ConversationItemStatus;
  role: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  revision: number;
  content: Record<string, unknown>;
  source_ref: Record<string, unknown>;
  long_lived: boolean;
  source: string;
  schema_version: number;
};

export type ConversationTurnPage = Record<string, unknown> & {
  thread_id: string;
  turns: ConversationTurn[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
};

export type ConversationItemPage = Record<string, unknown> & {
  thread_id: string;
  turn_id: string | null;
  items: ConversationItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
};

export type ConversationPageOptions = {
  limit?: number;
  cursor?: string;
  order?: ConversationOrder;
};

export type ConversationItemPageOptions = ConversationPageOptions & {
  turnId?: string;
  kinds?: readonly ConversationItemKind[];
};

export class ConversationProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConversationProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ConversationProtocolError(`${label} must be a string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConversationProtocolError(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConversationProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) {
    throw new ConversationProtocolError(`${label} must be positive`);
  }
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConversationProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label);
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function nullableRecord(value: unknown, label: string): Record<string, unknown> | null {
  return value === null ? null : record(value, label);
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new ConversationProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

function enumValue<const T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  const result = nonEmptyString(value, label);
  if (!allowed.has(result as T)) {
    throw new ConversationProtocolError(`${label} has unsupported value ${JSON.stringify(result)}`);
  }
  return result as T;
}

const threadStatuses = new Set<ConversationThreadStatus>(['active', 'archived']);
const turnStatuses = new Set<ConversationTurnStatus>(['running', 'completed', 'failed', 'cancelled']);
const itemStatuses = new Set<ConversationItemStatus>(['started', 'completed', 'failed', 'cancelled']);

export function decodeConversationThread(value: unknown, label = 'thread'): ConversationThread {
  const item = record(value, label);
  return {
    ...item,
    thread_id: nonEmptyString(item.thread_id, `${label}.thread_id`),
    user_id: nullableIdentifier(item.user_id, `${label}.user_id`),
    status: enumValue(item.status, threadStatuses, `${label}.status`),
    title: nullableString(item.title, `${label}.title`),
    created_at: finiteNumber(item.created_at, `${label}.created_at`),
    updated_at: finiteNumber(item.updated_at, `${label}.updated_at`),
    last_seq: nonNegativeInteger(item.last_seq, `${label}.last_seq`),
    turn_count: nonNegativeInteger(item.turn_count, `${label}.turn_count`),
    item_count: nonNegativeInteger(item.item_count, `${label}.item_count`),
    parent_thread_id: nullableIdentifier(item.parent_thread_id, `${label}.parent_thread_id`),
    branched_from_item_id: nullableIdentifier(item.branched_from_item_id, `${label}.branched_from_item_id`),
    usage: record(item.usage, `${label}.usage`),
    compaction: record(item.compaction, `${label}.compaction`),
    ...(item.pinned === undefined ? {} : { pinned: boolean(item.pinned, `${label}.pinned`) }),
    ...(item.metadata === undefined ? {} : { metadata: record(item.metadata, `${label}.metadata`) }),
    source: nonEmptyString(item.source, `${label}.source`),
    projected_at: nullableNumber(item.projected_at, `${label}.projected_at`),
    schema_version: positiveInteger(item.schema_version, `${label}.schema_version`),
  };
}

export function decodeConversationTurn(value: unknown, label = 'turn'): ConversationTurn {
  const item = record(value, label);
  return {
    ...item,
    turn_id: nonEmptyString(item.turn_id, `${label}.turn_id`),
    thread_id: nonEmptyString(item.thread_id, `${label}.thread_id`),
    ordinal: positiveInteger(item.ordinal, `${label}.ordinal`),
    status: enumValue(item.status, turnStatuses, `${label}.status`),
    created_at: finiteNumber(item.created_at, `${label}.created_at`),
    updated_at: finiteNumber(item.updated_at, `${label}.updated_at`),
    completed_at: nullableNumber(item.completed_at, `${label}.completed_at`),
    prompt: nullableString(item.prompt, `${label}.prompt`),
    prompt_role: nullableString(item.prompt_role, `${label}.prompt_role`),
    end_reason: nullableString(item.end_reason, `${label}.end_reason`),
    error: nullableRecord(item.error, `${label}.error`),
    usage: record(item.usage, `${label}.usage`),
    model: nullableString(item.model, `${label}.model`),
    model_ref: nullableString(item.model_ref, `${label}.model_ref`),
    item_count: nonNegativeInteger(item.item_count, `${label}.item_count`),
    first_seq: nullableNonNegativeInteger(item.first_seq, `${label}.first_seq`),
    last_seq: nullableNonNegativeInteger(item.last_seq, `${label}.last_seq`),
    attempts: nonNegativeInteger(item.attempts, `${label}.attempts`),
    source: nonEmptyString(item.source, `${label}.source`),
    schema_version: positiveInteger(item.schema_version, `${label}.schema_version`),
  };
}

export function decodeConversationItem(value: unknown, label = 'item'): ConversationItem {
  const item = record(value, label);
  return {
    ...item,
    item_id: nonEmptyString(item.item_id, `${label}.item_id`),
    thread_id: nonEmptyString(item.thread_id, `${label}.thread_id`),
    turn_id: nullableIdentifier(item.turn_id, `${label}.turn_id`),
    seq: positiveInteger(item.seq, `${label}.seq`),
    // Kinds are deliberately open: unknown kinds retain their canonical
    // identity/content so callers can render a fallback instead of losing history.
    kind: nonEmptyString(item.kind, `${label}.kind`),
    status: enumValue(item.status, itemStatuses, `${label}.status`),
    role: nullableString(item.role, `${label}.role`),
    created_at: finiteNumber(item.created_at, `${label}.created_at`),
    updated_at: finiteNumber(item.updated_at, `${label}.updated_at`),
    completed_at: nullableNumber(item.completed_at, `${label}.completed_at`),
    revision: nonNegativeInteger(item.revision, `${label}.revision`),
    content: record(item.content, `${label}.content`),
    source_ref: record(item.source_ref, `${label}.source_ref`),
    long_lived: boolean(item.long_lived, `${label}.long_lived`),
    source: nonEmptyString(item.source, `${label}.source`),
    schema_version: positiveInteger(item.schema_version, `${label}.schema_version`),
  };
}

function validateIdentifier(value: string, label: string): string {
  return nonEmptyString(value, label);
}

function pageParams(threadId: string, options: ConversationPageOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { thread_id: validateIdentifier(threadId, 'threadId') };
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit)) {
      throw new TypeError('Conversation page limit must be a safe integer');
    }
    params.limit = options.limit;
  }
  if (options.cursor !== undefined) {
    params.cursor = validateIdentifier(options.cursor, 'cursor');
  }
  if (options.order !== undefined) {
    if (options.order !== 'asc' && options.order !== 'desc') {
      throw new TypeError('Conversation page order must be asc or desc');
    }
    params.order = options.order;
  }
  return params;
}

function validatePageCursor(item: Record<string, unknown>, label: string): string | null {
  const cursor = nullableIdentifier(item.next_cursor, `${label}.next_cursor`);
  const hasMore = boolean(item.has_more, `${label}.has_more`);
  if (hasMore && cursor === null) {
    throw new ConversationProtocolError(`${label}.next_cursor is required while has_more is true`);
  }
  return cursor;
}

function assertOrdered(entries: readonly number[], order: ConversationOrder, label: string): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if ((order === 'asc' && current <= previous) || (order === 'desc' && current >= previous)) {
      throw new ConversationProtocolError(`${label} must be strictly ${order === 'asc' ? 'ascending' : 'descending'}`);
    }
  }
}

export class ConversationClient {
  constructor(private readonly rpc: ConversationRpcTransport) {}

  async getThread(threadId: string): Promise<ConversationThread> {
    const expectedThreadId = validateIdentifier(threadId, 'threadId');
    const result = decodeConversationThread(
      await this.rpc.request('get_thread', { thread_id: expectedThreadId }),
      'get_thread'
    );
    if (result.thread_id !== expectedThreadId) {
      throw new ConversationProtocolError('get_thread returned a different thread_id');
    }
    return result;
  }

  async listTurns(threadId: string, options: ConversationPageOptions = {}): Promise<ConversationTurnPage> {
    const params = pageParams(threadId, options) as unknown as RpcMethodMap['list_turns']['params'];
    const raw = record(await this.rpc.request('list_turns', params), 'list_turns');
    const resultThreadId = nonEmptyString(raw.thread_id, 'list_turns.thread_id');
    if (resultThreadId !== params.thread_id) {
      throw new ConversationProtocolError('list_turns returned a different thread_id');
    }
    const turns = array(raw.turns, decodeConversationTurn, 'list_turns.turns');
    if (turns.some((turn) => turn.thread_id !== params.thread_id)) {
      throw new ConversationProtocolError('list_turns returned a turn for a different thread_id');
    }
    assertOrdered(
      turns.map((turn) => turn.ordinal),
      options.order ?? 'asc',
      'list_turns.turns ordinals'
    );
    return {
      ...raw,
      thread_id: resultThreadId,
      turns,
      next_cursor: validatePageCursor(raw, 'list_turns'),
      has_more: boolean(raw.has_more, 'list_turns.has_more'),
      total: nonNegativeInteger(raw.total, 'list_turns.total'),
    };
  }

  async listItems(threadId: string, options: ConversationItemPageOptions = {}): Promise<ConversationItemPage> {
    const params = pageParams(threadId, options);
    if (options.turnId !== undefined) {
      params.turn_id = validateIdentifier(options.turnId, 'turnId');
    }
    if (options.kinds !== undefined) {
      params.kinds = options.kinds.map((kind, index) => nonEmptyString(kind, `kinds[${index}]`));
    }
    const request = params as unknown as RpcMethodMap['list_items']['params'];
    const raw = record(await this.rpc.request('list_items', request), 'list_items');
    const resultThreadId = nonEmptyString(raw.thread_id, 'list_items.thread_id');
    if (resultThreadId !== request.thread_id) {
      throw new ConversationProtocolError('list_items returned a different thread_id');
    }
    const resultTurnId = nullableIdentifier(raw.turn_id, 'list_items.turn_id');
    if (resultTurnId !== (request.turn_id ?? null)) {
      throw new ConversationProtocolError('list_items returned a different turn_id');
    }
    const items = array(raw.items, decodeConversationItem, 'list_items.items');
    if (items.some((item) => item.thread_id !== request.thread_id)) {
      throw new ConversationProtocolError('list_items returned an item for a different thread_id');
    }
    if (request.turn_id !== undefined && items.some((item) => item.turn_id !== request.turn_id)) {
      throw new ConversationProtocolError('list_items returned an item for a different turn_id');
    }
    assertOrdered(
      items.map((item) => item.seq),
      options.order ?? 'asc',
      'list_items.items seq values'
    );
    return {
      ...raw,
      thread_id: resultThreadId,
      turn_id: resultTurnId,
      items,
      next_cursor: validatePageCursor(raw, 'list_items'),
      has_more: boolean(raw.has_more, 'list_items.has_more'),
      total: nonNegativeInteger(raw.total, 'list_items.total'),
    };
  }

  async getItem(threadId: string, itemId: string): Promise<ConversationItem> {
    const expectedThreadId = validateIdentifier(threadId, 'threadId');
    const expectedItemId = validateIdentifier(itemId, 'itemId');
    const result = decodeConversationItem(
      await this.rpc.request('get_item', { thread_id: expectedThreadId, item_id: expectedItemId }),
      'get_item'
    );
    if (result.thread_id !== expectedThreadId || result.item_id !== expectedItemId) {
      throw new ConversationProtocolError('get_item returned different canonical identifiers');
    }
    return result;
  }
}
