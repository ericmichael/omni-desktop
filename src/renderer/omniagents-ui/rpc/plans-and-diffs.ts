import type { ItemUpdatedParams, RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

type PlansAndDiffsMethod = 'get_plan' | 'get_run_diff';

export interface PlansAndDiffsTransport {
  request<Method extends PlansAndDiffsMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on<Event extends 'item_updated'>(event: Event, handler: (payload: RpcNotificationMap[Event]) => void): () => void;
}

export type ItemLifecycleStatus = 'started' | 'completed' | 'failed' | 'cancelled';
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type RunDiffChangeType = 'added' | 'modified' | 'deleted';

export type PlanStep = Record<string, unknown> & {
  id: string;
  subject: string;
  description: string;
  active_form: string;
  status: PlanStepStatus;
  owner: string;
  blocks: string[];
  blocked_by: string[];
};

export type PlanCounts = Record<string, unknown> & {
  pending: number;
  in_progress: number;
  completed: number;
  blocked: number;
};

export type PlanItem = Record<string, unknown> & {
  plan_id: string;
  item_id: string;
  thread_id: string;
  turn_id: string | null;
  scope: string;
  generation: number;
  steps: PlanStep[];
  counts: PlanCounts;
  status: ItemLifecycleStatus;
  finalized_by: string | null;
  revision: number;
  updated_at: number;
};

export type PlanResult = Record<string, unknown> & {
  thread_id: string;
  scope: string;
  plan: PlanItem | null;
  plans: PlanItem[];
};

export type RunDiffFile = Record<string, unknown> & {
  path: string;
  change_type: RunDiffChangeType;
  additions: number;
  deletions: number;
  /** True for binary or oversized content. Such files honestly have no hunks. */
  opaque: boolean;
  /** True when the run observer could not prove the file's pre-image. */
  baseline_unknown: boolean;
};

export type RunDiffStats = Record<string, unknown> & {
  files_changed: number;
  additions: number;
  deletions: number;
};

export type RunDiffItem = Record<string, unknown> & {
  run_id: string;
  item_id: string;
  status: ItemLifecycleStatus;
  revision: number;
  updated_at: number;
  diff: string;
  files: RunDiffFile[];
  stats: RunDiffStats;
  truncated: boolean;
  files_truncated: boolean;
};

export type RunDiffResult = Record<string, unknown> & {
  thread_id: string;
  turn_id: string | null;
  /** Null is the ordinary, authoritative answer when the turn changed no observed files. */
  run_diff: RunDiffItem | null;
};

export type PlansAndDiffsItem = PlanItem | RunDiffItem;

export class PlansAndDiffsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlansAndDiffsProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlansAndDiffsProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlansAndDiffsProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new PlansAndDiffsProtocolError(`${label} must be a string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PlansAndDiffsProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PlansAndDiffsProtocolError(`${label} must be a finite number`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PlansAndDiffsProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new PlansAndDiffsProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function lifecycleStatus(value: unknown, label: string): ItemLifecycleStatus {
  if (value !== 'started' && value !== 'completed' && value !== 'failed' && value !== 'cancelled') {
    throw new PlansAndDiffsProtocolError(`${label} has an unsupported lifecycle status`);
  }
  return value;
}

function planStep(value: unknown, label: string): PlanStep {
  const item = record(value, label);
  const status = item.status;
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'blocked') {
    throw new PlansAndDiffsProtocolError(`${label}.status has an unsupported plan status`);
  }
  return {
    ...item,
    id: nonEmptyString(item.id, `${label}.id`),
    subject: stringValue(item.subject, `${label}.subject`),
    description: stringValue(item.description, `${label}.description`),
    active_form: stringValue(item.active_form, `${label}.active_form`),
    status,
    owner: stringValue(item.owner, `${label}.owner`),
    blocks: stringArray(item.blocks, `${label}.blocks`),
    blocked_by: stringArray(item.blocked_by, `${label}.blocked_by`),
  };
}

function planCounts(value: unknown, label: string): PlanCounts {
  const item = record(value, label);
  return {
    ...item,
    pending: nonNegativeInteger(item.pending, `${label}.pending`),
    in_progress: nonNegativeInteger(item.in_progress, `${label}.in_progress`),
    completed: nonNegativeInteger(item.completed, `${label}.completed`),
    blocked: nonNegativeInteger(item.blocked, `${label}.blocked`),
  };
}

export function parsePlanItem(value: unknown, label = 'plan'): PlanItem {
  const item = record(value, label);
  if (!Array.isArray(item.steps)) {
    throw new PlansAndDiffsProtocolError(`${label}.steps must be an array`);
  }
  const planId = nonEmptyString(item.plan_id, `${label}.plan_id`);
  const itemId = nonEmptyString(item.item_id, `${label}.item_id`);
  if (planId !== itemId) {
    throw new PlansAndDiffsProtocolError(`${label}.plan_id must equal item_id`);
  }
  return {
    ...item,
    plan_id: planId,
    item_id: itemId,
    thread_id: nonEmptyString(item.thread_id, `${label}.thread_id`),
    turn_id: nullableString(item.turn_id, `${label}.turn_id`),
    scope: nonEmptyString(item.scope, `${label}.scope`),
    generation: nonNegativeInteger(item.generation, `${label}.generation`),
    steps: item.steps.map((step, index) => planStep(step, `${label}.steps[${index}]`)),
    counts: planCounts(item.counts, `${label}.counts`),
    status: lifecycleStatus(item.status, `${label}.status`),
    finalized_by: nullableString(item.finalized_by, `${label}.finalized_by`),
    revision: nonNegativeInteger(item.revision, `${label}.revision`),
    updated_at: finiteNumber(item.updated_at, `${label}.updated_at`),
  };
}

function runDiffFile(value: unknown, label: string): RunDiffFile {
  const item = record(value, label);
  const changeType = item.change_type;
  if (changeType !== 'added' && changeType !== 'modified' && changeType !== 'deleted') {
    throw new PlansAndDiffsProtocolError(`${label}.change_type has an unsupported value`);
  }
  return {
    ...item,
    path: nonEmptyString(item.path, `${label}.path`),
    change_type: changeType,
    additions: nonNegativeInteger(item.additions, `${label}.additions`),
    deletions: nonNegativeInteger(item.deletions, `${label}.deletions`),
    opaque: booleanValue(item.opaque, `${label}.opaque`),
    baseline_unknown: booleanValue(item.baseline_unknown, `${label}.baseline_unknown`),
  };
}

function runDiffStats(value: unknown, label: string): RunDiffStats {
  const item = record(value, label);
  return {
    ...item,
    files_changed: nonNegativeInteger(item.files_changed, `${label}.files_changed`),
    additions: nonNegativeInteger(item.additions, `${label}.additions`),
    deletions: nonNegativeInteger(item.deletions, `${label}.deletions`),
  };
}

export function parseRunDiffItem(value: unknown, label = 'run_diff'): RunDiffItem {
  const item = record(value, label);
  if (!Array.isArray(item.files)) {
    throw new PlansAndDiffsProtocolError(`${label}.files must be an array`);
  }
  return {
    ...item,
    run_id: nonEmptyString(item.run_id, `${label}.run_id`),
    item_id: nonEmptyString(item.item_id, `${label}.item_id`),
    status: lifecycleStatus(item.status, `${label}.status`),
    revision: nonNegativeInteger(item.revision, `${label}.revision`),
    updated_at: finiteNumber(item.updated_at, `${label}.updated_at`),
    diff: stringValue(item.diff, `${label}.diff`),
    files: item.files.map((file, index) => runDiffFile(file, `${label}.files[${index}]`)),
    stats: runDiffStats(item.stats, `${label}.stats`),
    truncated: booleanValue(item.truncated, `${label}.truncated`),
    files_truncated: booleanValue(item.files_truncated, `${label}.files_truncated`),
  };
}

export function parsePlanResult(value: unknown): PlanResult {
  const result = record(value, 'get_plan result');
  if (!Array.isArray(result.plans)) {
    throw new PlansAndDiffsProtocolError('get_plan result.plans must be an array');
  }
  const threadId = nonEmptyString(result.thread_id, 'get_plan result.thread_id');
  const plan = result.plan === null ? null : parsePlanItem(result.plan, 'get_plan result.plan');
  const plans = result.plans.map((entry, index) => parsePlanItem(entry, `get_plan result.plans[${index}]`));
  if (plan && plan.thread_id !== threadId) {
    throw new PlansAndDiffsProtocolError('get_plan result.plan belongs to another thread');
  }
  if (plans.some((entry) => entry.thread_id !== threadId)) {
    throw new PlansAndDiffsProtocolError('get_plan result.plans contains another thread');
  }
  return {
    ...result,
    thread_id: threadId,
    scope: nonEmptyString(result.scope, 'get_plan result.scope'),
    plan,
    plans,
  };
}

export function parseRunDiffResult(value: unknown): RunDiffResult {
  const result = record(value, 'get_run_diff result');
  const turnId = result.turn_id === null ? null : nonEmptyString(result.turn_id, 'get_run_diff result.turn_id');
  const runDiff = result.run_diff === null ? null : parseRunDiffItem(result.run_diff, 'get_run_diff result.run_diff');
  if (runDiff && runDiff.run_id !== turnId) {
    throw new PlansAndDiffsProtocolError('get_run_diff result.run_diff belongs to another turn');
  }
  return {
    ...result,
    thread_id: nonEmptyString(result.thread_id, 'get_run_diff result.thread_id'),
    turn_id: turnId,
    run_diff: runDiff,
  };
}

function itemFromUpdate(payload: ItemUpdatedParams): PlansAndDiffsItem | null {
  if (payload.kind !== 'plan' && payload.kind !== 'run_diff') {
    return null;
  }
  const content = record(payload.content, 'item_updated.content');
  const { content: _content, ...envelope } = payload;
  const common = {
    ...content,
    ...envelope,
    item_id: nonEmptyString(payload.item_id, 'item_updated.item_id'),
    revision: nonNegativeInteger(payload.revision, 'item_updated.revision'),
    status: lifecycleStatus(payload.status, 'item_updated.status'),
    updated_at: finiteNumber(payload.updated_at, 'item_updated.updated_at'),
  };
  if (payload.kind === 'plan') {
    return parsePlanItem(
      {
        ...common,
        thread_id: payload.thread_id,
        turn_id: payload.turn_id ?? null,
        finalized_by: content.finalized_by ?? null,
      },
      'item_updated plan'
    );
  }
  return parseRunDiffItem(common, 'item_updated run_diff');
}

/**
 * Read client plus a revision-aware in-memory projection of plan/run-diff
 * items. Authoritative reads and replayed ``item_updated`` notifications use
 * the same validators and converge through one monotonic cache operation.
 */
export class PlansAndDiffsClient {
  private readonly items = new Map<string, PlansAndDiffsItem>();
  private readonly listeners = new Set<(item: PlansAndDiffsItem) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly rpc: PlansAndDiffsTransport) {
    this.unsubscribe = rpc.on('item_updated', (payload) => {
      const item = itemFromUpdate(payload);
      if (item) {
        this.adopt(item);
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  onItemUpdated(listener: (item: PlansAndDiffsItem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCached(itemId: string): PlansAndDiffsItem | undefined {
    return this.items.get(itemId);
  }

  async getPlan(threadId: string, scope?: string): Promise<PlanResult> {
    const params: RpcMethodMap['get_plan']['params'] = { thread_id: nonEmptyString(threadId, 'thread_id') };
    if (scope !== undefined) {
      params.scope = nonEmptyString(scope, 'scope');
    }
    const result = parsePlanResult(await this.rpc.request('get_plan', params));
    for (const plan of result.plans) {
      this.adopt(plan);
    }
    if (result.plan) {
      this.adopt(result.plan);
    }
    return result;
  }

  async getRunDiff(threadId: string, turnId?: string): Promise<RunDiffResult> {
    const params: RpcMethodMap['get_run_diff']['params'] = { thread_id: nonEmptyString(threadId, 'thread_id') };
    if (turnId !== undefined) {
      params.turn_id = nonEmptyString(turnId, 'turn_id');
    }
    const result = parseRunDiffResult(await this.rpc.request('get_run_diff', params));
    if (result.run_diff) {
      this.adopt(result.run_diff);
    }
    return result;
  }

  private adopt(item: PlansAndDiffsItem): boolean {
    const current = this.items.get(item.item_id);
    if (current && item.revision <= current.revision) {
      return false;
    }
    this.items.set(item.item_id, item);
    for (const listener of this.listeners) {
      listener(item);
    }
    return true;
  }
}
