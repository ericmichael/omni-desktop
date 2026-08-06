import type { ElicitationResponseParams, RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

export type ElicitationKind = 'question' | 'confirm' | 'select' | 'form' | 'url';
export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationStatus = 'accepted' | 'declined' | 'cancelled' | 'expired' | 'server_restart';

export interface ElicitationOption {
  value: unknown;
  label: string;
  description?: string;
}

interface ElicitationRequestBase {
  elicitationId: string;
  message: string;
  title?: string;
  sessionId?: string;
  runId?: string;
  itemId?: string;
  source?: string;
  timeoutMs?: number;
  expiresAt?: string;
  /** False by default. False means answers must never enter durable client state. */
  persistResponse: boolean;
  /** Convenience flag for renderers deciding how aggressively to mask fields. */
  sensitive: boolean;
  seq?: number;
  streamId?: string;
}

export type ElicitationRequest =
  | (ElicitationRequestBase & { kind: 'question' })
  | (ElicitationRequestBase & { kind: 'confirm' })
  | (ElicitationRequestBase & { kind: 'select'; options: ElicitationOption[] })
  | (ElicitationRequestBase & { kind: 'form'; inputSchema: Record<string, unknown> })
  | (ElicitationRequestBase & { kind: 'url'; url: string });

export interface ElicitationResolution {
  elicitationId: string;
  status: ElicitationStatus;
  sessionId?: string;
  runId?: string;
  action?: ElicitationAction;
  /** Present only for requests which explicitly allow response persistence. */
  value?: Record<string, unknown>;
  reason?: string;
  seq?: number;
  streamId?: string;
}

export type ElicitationResponse =
  | { action: 'accept'; value?: Record<string, unknown> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel'; reason?: string };

export type ElicitationSubmitResult = {
  elicitationId: string;
  status: ElicitationStatus;
  /** False when another tab/client supplied the response first. */
  won: boolean;
};

export type ElicitationQueueEvent =
  | { type: 'requested'; request: ElicitationRequest }
  | { type: 'removed'; request: ElicitationRequest; resolution: ElicitationResolution };

export type ElicitationReceiveResult =
  | { type: 'queued'; request: ElicitationRequest }
  | { type: 'unsupported'; elicitationId: string; response: ElicitationResponseParams; responseSent: boolean }
  | { type: 'malformed'; error: ElicitationDecodeError };

export interface ElicitationRpcTransport {
  request(
    method: 'elicitation_response',
    params: RpcMethodMap['elicitation_response']['params']
  ): Promise<RpcMethodMap['elicitation_response']['result']>;
}

export interface ElicitationQueueOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  supports?: (request: ElicitationRequest) => boolean;
}

export class ElicitationDecodeError extends Error {
  constructor(
    message: string,
    readonly elicitationId?: string
  ) {
    super(message);
    this.name = 'ElicitationDecodeError';
  }
}

export class ElicitationValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
    this.name = 'ElicitationValidationError';
  }
}

export class ElicitationNotPendingError extends Error {
  constructor(readonly elicitationId: string) {
    super(`Elicitation ${elicitationId} is not pending`);
    this.name = 'ElicitationNotPendingError';
  }
}

const KINDS = new Set<ElicitationKind>(['question', 'confirm', 'select', 'form', 'url']);
const ACTIONS = new Set<ElicitationAction>(['accept', 'decline', 'cancel']);
const STATUSES = new Set<ElicitationStatus>(['accepted', 'declined', 'cancelled', 'expired', 'server_restart']);
const GLOBAL_SESSION = '';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ElicitationDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, field: string, label: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new ElicitationDecodeError(`${label}.${field} must be a non-empty string`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, field: string, label: string): string | undefined {
  const result = value[field];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== 'string') {
    throw new ElicitationDecodeError(`${label}.${field} must be a string`);
  }
  return result;
}

function optionalNumber(value: Record<string, unknown>, field: string, label: string): number | undefined {
  const result = value[field];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) {
    throw new ElicitationDecodeError(`${label}.${field} must be a non-negative finite number`);
  }
  return result;
}

function decodeOptions(value: unknown, elicitationId: string): ElicitationOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ElicitationDecodeError('elicitation_requested.options must be a non-empty array', elicitationId);
  }
  return value.map((option, index) => {
    if (typeof option === 'string') {
      return { value: option, label: option };
    }
    const item = record(option, `elicitation_requested.options[${index}]`);
    if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
      throw new ElicitationDecodeError(`elicitation_requested.options[${index}].value is required`, elicitationId);
    }
    const label = item.label === undefined ? String(item.value) : optionalString(item, 'label', 'option');
    const description = optionalString(item, 'description', 'option');
    return { value: item.value, label: label!, ...(description === undefined ? {} : { description }) };
  });
}

/** Runtime-decode the generated notification's intentionally open fields. */
export function decodeElicitationRequested(
  value: RpcNotificationMap['elicitation_requested'] | unknown
): ElicitationRequest {
  const input = record(value, 'elicitation_requested');
  const elicitationId = requiredString(input, 'elicitation_id', 'elicitation_requested');
  try {
    const rawKind = requiredString(input, 'kind', 'elicitation_requested');
    if (!KINDS.has(rawKind as ElicitationKind)) {
      throw new ElicitationDecodeError(`Unsupported elicitation kind ${JSON.stringify(rawKind)}`, elicitationId);
    }
    const kind = rawKind as ElicitationKind;
    const expiresAt = optionalString(input, 'expires_at', 'elicitation_requested');
    if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) {
      throw new ElicitationDecodeError('elicitation_requested.expires_at must be an ISO timestamp', elicitationId);
    }
    if (input.persist_response !== undefined && typeof input.persist_response !== 'boolean') {
      throw new ElicitationDecodeError('elicitation_requested.persist_response must be a boolean', elicitationId);
    }
    const persistResponse = input.persist_response === true;
    const base: ElicitationRequestBase = {
      elicitationId,
      message: requiredString(input, 'message', 'elicitation_requested'),
      persistResponse,
      sensitive: !persistResponse,
    };
    const fields = {
      title: optionalString(input, 'title', 'elicitation_requested'),
      sessionId: optionalString(input, 'session_id', 'elicitation_requested'),
      runId: optionalString(input, 'run_id', 'elicitation_requested'),
      itemId: optionalString(input, 'item_id', 'elicitation_requested'),
      source: optionalString(input, 'source', 'elicitation_requested'),
      timeoutMs: optionalNumber(input, 'timeout_ms', 'elicitation_requested'),
      expiresAt,
      seq: optionalNumber(input, 'seq', 'elicitation_requested'),
      streamId: optionalString(input, 'stream_id', 'elicitation_requested'),
    };
    const common = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
    if (kind === 'select') {
      return { ...base, ...common, kind, options: decodeOptions(input.options, elicitationId) } as ElicitationRequest;
    }
    if (kind === 'form') {
      return {
        ...base,
        ...common,
        kind,
        inputSchema: record(input.input_schema, 'elicitation_requested.input_schema'),
      } as ElicitationRequest;
    }
    if (kind === 'url') {
      const url = requiredString(input, 'url', 'elicitation_requested');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ElicitationDecodeError('elicitation_requested.url must be an absolute URL', elicitationId);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ElicitationDecodeError('elicitation_requested.url must use http or https', elicitationId);
      }
      return { ...base, ...common, kind, url } as ElicitationRequest;
    }
    return { ...base, ...common, kind } as ElicitationRequest;
  } catch (error) {
    if (error instanceof ElicitationDecodeError && error.elicitationId === undefined) {
      throw new ElicitationDecodeError(error.message, elicitationId);
    }
    throw error;
  }
}

export function decodeElicitationResolved(
  value: RpcNotificationMap['elicitation_resolved'] | unknown
): ElicitationResolution {
  const input = record(value, 'elicitation_resolved');
  const elicitationId = requiredString(input, 'elicitation_id', 'elicitation_resolved');
  const rawStatus = requiredString(input, 'status', 'elicitation_resolved');
  if (!STATUSES.has(rawStatus as ElicitationStatus)) {
    throw new ElicitationDecodeError(`Unknown elicitation status ${JSON.stringify(rawStatus)}`, elicitationId);
  }
  const rawAction = optionalString(input, 'action', 'elicitation_resolved');
  if (rawAction !== undefined && !ACTIONS.has(rawAction as ElicitationAction)) {
    throw new ElicitationDecodeError(`Unknown elicitation action ${JSON.stringify(rawAction)}`, elicitationId);
  }
  const valueRecord = input.value === undefined ? undefined : record(input.value, 'elicitation_resolved.value');
  return {
    elicitationId,
    status: rawStatus as ElicitationStatus,
    ...(optionalString(input, 'session_id', 'elicitation_resolved') === undefined
      ? {}
      : { sessionId: input.session_id as string }),
    ...(optionalString(input, 'run_id', 'elicitation_resolved') === undefined ? {} : { runId: input.run_id as string }),
    ...(rawAction === undefined ? {} : { action: rawAction as ElicitationAction }),
    ...(valueRecord === undefined ? {} : { value: valueRecord }),
    ...(optionalString(input, 'reason', 'elicitation_resolved') === undefined
      ? {}
      : { reason: input.reason as string }),
    ...(optionalNumber(input, 'seq', 'elicitation_resolved') === undefined ? {} : { seq: input.seq as number }),
    ...(optionalString(input, 'stream_id', 'elicitation_resolved') === undefined
      ? {}
      : { streamId: input.stream_id as string }),
  };
}

export function unsupportedByClientResponse(elicitationId: string): ElicitationResponseParams {
  return {
    elicitation_id: elicitationId,
    action: 'decline',
    reason: 'unsupported_by_client',
  };
}

function schemasEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => schemasEqual(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every((key) => schemasEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

/** Conservative form support for the first Desktop renderer: flat primitive fields. */
export function isDefaultRenderableElicitation(request: ElicitationRequest): boolean {
  if (request.kind !== 'form') {
    return true;
  }
  const schema = request.inputSchema;
  const unsupportedKeywords = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', 'patternProperties'];
  if (
    unsupportedKeywords.some((keyword) => schema[keyword] !== undefined) ||
    schema.type !== 'object' ||
    (schema.properties !== undefined &&
      (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)))
  ) {
    return false;
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))
  ) {
    return false;
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return Object.values(properties).every((property) => {
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
      return false;
    }
    const type = (property as Record<string, unknown>).type;
    return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
  });
}

function validatePrimitive(value: unknown, schema: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const validType =
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) ||
    (type === 'boolean' && typeof value === 'boolean');
  if (!validType) {
    errors.push(`${path} must be ${String(type)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => schemasEqual(choice, value))) {
    errors.push(`${path} must be one of the offered values`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }
  return errors;
}

export function validateElicitationResponse(request: ElicitationRequest, response: ElicitationResponse): string[] {
  if (response.action !== 'accept') {
    return [];
  }
  const value = response.value;
  if (request.kind === 'question') {
    return typeof value?.text === 'string' && value.text.trim().length > 0
      ? []
      : ['value.text must be a non-empty string'];
  }
  if (request.kind === 'confirm') {
    return typeof value?.confirmed === 'boolean' ? [] : ['value.confirmed must be a boolean'];
  }
  if (request.kind === 'select') {
    if (!Array.isArray(value?.selected)) {
      return ['value.selected must be an array'];
    }
    return value.selected.every((selected) => request.options.some((option) => schemasEqual(option.value, selected)))
      ? []
      : ['value.selected contains a value that was not offered'];
  }
  if (request.kind === 'url') {
    return value === undefined || (value && typeof value === 'object' && !Array.isArray(value))
      ? []
      : ['value must be an acknowledgement object'];
  }
  if (!value) {
    return ['value must be an object'];
  }
  if (!isDefaultRenderableElicitation(request)) {
    return ['input_schema is unsupported by this client'];
  }
  const schema = request.inputSchema;
  const required = new Set((schema.required ?? []) as string[]);
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const errors: string[] = [];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(`value.${field} is required`);
    }
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    const property = properties[field];
    if (!property) {
      if (schema.additionalProperties === false) {
        errors.push(`value.${field} is not allowed`);
      }
      continue;
    }
    errors.push(...validatePrimitive(fieldValue, property, `value.${field}`));
  }
  return errors;
}

function responseParams(elicitationId: string, response: ElicitationResponse): ElicitationResponseParams {
  return {
    elicitation_id: elicitationId,
    action: response.action,
    ...(response.action === 'accept' && response.value !== undefined ? { value: response.value } : {}),
    ...(response.action !== 'accept' && response.reason !== undefined ? { reason: response.reason } : {}),
  };
}

function errorCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined;
}

function alreadyResolvedStatus(error: unknown): ElicitationStatus {
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined;
  const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : undefined;
  return typeof status === 'string' && STATUSES.has(status as ElicitationStatus)
    ? (status as ElicitationStatus)
    : 'cancelled';
}

export class ElicitationQueue {
  private readonly pending = new Map<string, ElicitationRequest>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<ElicitationSubmitResult>>();
  private readonly listeners = new Set<(event: ElicitationQueueEvent) => void>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly supports: (request: ElicitationRequest) => boolean;

  constructor(
    private readonly transport: ElicitationRpcTransport,
    options: ElicitationQueueOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.supports = options.supports ?? isDefaultRenderableElicitation;
  }

  onChange(listener: (event: ElicitationQueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(elicitationId: string): ElicitationRequest | undefined {
    return this.pending.get(elicitationId);
  }

  list(sessionId?: string): ElicitationRequest[] {
    if (arguments.length === 0) {
      return [...this.pending.values()];
    }
    const ids = this.bySession.get(sessionId ?? GLOBAL_SESSION);
    return ids ? [...ids].map((id) => this.pending.get(id)).filter((item): item is ElicitationRequest => !!item) : [];
  }

  async receiveRequested(
    value: RpcNotificationMap['elicitation_requested'] | unknown
  ): Promise<ElicitationReceiveResult> {
    let request: ElicitationRequest;
    try {
      request = decodeElicitationRequested(value);
    } catch (error) {
      const decodedError =
        error instanceof ElicitationDecodeError
          ? error
          : new ElicitationDecodeError((error as Error).message || 'Malformed elicitation request');
      if (!decodedError.elicitationId) {
        return { type: 'malformed', error: decodedError };
      }
      return this.declineUnsupported(decodedError.elicitationId);
    }

    if (!this.supports(request)) {
      return this.declineUnsupported(request.elicitationId);
    }

    const existing = this.pending.get(request.elicitationId);
    if (existing && existing.sessionId !== request.sessionId) {
      return {
        type: 'malformed',
        error: new ElicitationDecodeError(
          `Elicitation ${request.elicitationId} was replayed for a different session`,
          request.elicitationId
        ),
      };
    }
    if (existing && existing.seq !== undefined && request.seq !== undefined && request.seq < existing.seq) {
      return { type: 'queued', request: existing };
    }
    if (existing) {
      this.removeIndex(existing);
    }
    this.pending.set(request.elicitationId, request);
    this.addIndex(request);
    this.scheduleExpiry(request);
    this.emit({ type: 'requested', request });
    return { type: 'queued', request };
  }

  receiveResolved(value: RpcNotificationMap['elicitation_resolved'] | unknown): ElicitationResolution {
    const resolution = decodeElicitationResolved(value);
    const request = this.pending.get(resolution.elicitationId);
    if (request?.sessionId && resolution.sessionId && request.sessionId !== resolution.sessionId) {
      throw new ElicitationDecodeError(
        `Resolution for ${resolution.elicitationId} belongs to a different session`,
        resolution.elicitationId
      );
    }
    // Unknown prompts are sensitive by default. A value may only reach a
    // subscriber when the matching request explicitly allowed persistence.
    const { value: _discardedValue, ...safeResolution } = resolution;
    const sanitized = request?.persistResponse ? resolution : safeResolution;
    if (request) {
      this.remove(request, sanitized);
    }
    return sanitized;
  }

  respond(elicitationId: string, response: ElicitationResponse): Promise<ElicitationSubmitResult> {
    const current = this.inFlight.get(elicitationId);
    if (current) {
      return current;
    }
    const request = this.pending.get(elicitationId);
    if (!request) {
      return Promise.reject(new ElicitationNotPendingError(elicitationId));
    }
    const errors = validateElicitationResponse(request, response);
    if (errors.length > 0) {
      return Promise.reject(new ElicitationValidationError(errors));
    }
    const submission = this.submit(request, response);
    this.inFlight.set(elicitationId, submission);
    const cleanup = (): void => {
      if (this.inFlight.get(elicitationId) === submission) {
        this.inFlight.delete(elicitationId);
      }
    };
    void submission.then(cleanup, cleanup);
    return submission;
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      this.clearTimer(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.bySession.clear();
    this.listeners.clear();
  }

  private async declineUnsupported(elicitationId: string): Promise<ElicitationReceiveResult> {
    const response = unsupportedByClientResponse(elicitationId);
    try {
      await this.transport.request('elicitation_response', response);
      return { type: 'unsupported', elicitationId, response, responseSent: true };
    } catch {
      return { type: 'unsupported', elicitationId, response, responseSent: false };
    }
  }

  private async submit(request: ElicitationRequest, response: ElicitationResponse): Promise<ElicitationSubmitResult> {
    try {
      const raw = await this.transport.request('elicitation_response', responseParams(request.elicitationId, response));
      const result = record(raw, 'elicitation_response result');
      const rawStatus = requiredString(result, 'status', 'elicitation_response result');
      if (!STATUSES.has(rawStatus as ElicitationStatus)) {
        throw new ElicitationDecodeError(`Unknown elicitation response status ${JSON.stringify(rawStatus)}`);
      }
      const status = rawStatus as ElicitationStatus;
      const pending = this.pending.get(request.elicitationId);
      if (pending) {
        this.remove(pending, {
          elicitationId: request.elicitationId,
          status,
          sessionId: request.sessionId,
          runId: request.runId,
          action: response.action,
          ...(response.action === 'decline' || response.action === 'cancel' ? { reason: response.reason } : {}),
        });
      }
      return { elicitationId: request.elicitationId, status, won: true };
    } catch (error) {
      if (errorCode(error) === -32051) {
        const status = alreadyResolvedStatus(error);
        const pending = this.pending.get(request.elicitationId);
        if (pending) {
          this.remove(pending, { elicitationId: request.elicitationId, status });
        }
        return { elicitationId: request.elicitationId, status, won: false };
      }
      throw error;
    }
  }

  private scheduleExpiry(request: ElicitationRequest): void {
    const oldTimer = this.timers.get(request.elicitationId);
    if (oldTimer !== undefined) {
      this.clearTimer(oldTimer);
    }
    const expiresAt = request.expiresAt === undefined ? undefined : Date.parse(request.expiresAt);
    const deadline = expiresAt ?? (request.timeoutMs === undefined ? undefined : this.now() + request.timeoutMs);
    if (deadline === undefined) {
      this.timers.delete(request.elicitationId);
      return;
    }
    const expire = (): void => {
      this.timers.delete(request.elicitationId);
      const pending = this.pending.get(request.elicitationId);
      if (pending === request) {
        this.remove(pending, {
          elicitationId: pending.elicitationId,
          status: 'expired',
          sessionId: pending.sessionId,
          runId: pending.runId,
          reason: 'deadline_elapsed',
        });
      }
    };
    const delay = Math.max(0, deadline - this.now());
    this.timers.set(request.elicitationId, this.setTimer(expire, delay));
  }

  private addIndex(request: ElicitationRequest): void {
    const key = request.sessionId ?? GLOBAL_SESSION;
    let ids = this.bySession.get(key);
    if (!ids) {
      ids = new Set();
      this.bySession.set(key, ids);
    }
    ids.add(request.elicitationId);
  }

  private removeIndex(request: ElicitationRequest): void {
    const key = request.sessionId ?? GLOBAL_SESSION;
    const ids = this.bySession.get(key);
    ids?.delete(request.elicitationId);
    if (ids?.size === 0) {
      this.bySession.delete(key);
    }
  }

  private remove(request: ElicitationRequest, resolution: ElicitationResolution): void {
    this.pending.delete(request.elicitationId);
    this.removeIndex(request);
    const timer = this.timers.get(request.elicitationId);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.timers.delete(request.elicitationId);
    }
    this.emit({ type: 'removed', request, resolution });
  }

  private emit(event: ElicitationQueueEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}
