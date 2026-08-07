import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

type ModelCatalogMethod = Extract<
  keyof RpcMethodMap,
  'list_models' | 'get_model' | 'list_providers' | 'set_session_model' | 'set_session_reasoning'
>;

export interface ModelCatalogRpcTransport {
  request<Method extends ModelCatalogMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ProviderHealthStatus = 'ok' | 'needs_auth' | 'error';

export type CatalogReason = Record<string, unknown> & {
  code: string;
  message: string;
  action?: string;
};

export type CatalogProviderError = Record<string, unknown> & {
  provider: string;
  code: string;
  message: string;
};

export type ModelDescriptor = Record<string, unknown> & {
  id: string;
  model: string | null;
  label: string;
  description: string | null;
  provider: Record<string, unknown> & { name: string | null; type: string | null };
  modalities: string[];
  realtime: boolean;
  limits: Record<string, unknown> & { max_input_tokens: number | null; max_output_tokens: number | null };
  reasoning: Record<string, unknown> & { default: string | null; options: string[] };
  tiers: Record<string, unknown> & { service: string | null; speed: string | null };
  personality: Record<string, unknown> & { supported: boolean; options: string[]; default: string | null };
  availability: Record<string, unknown> & { available: boolean; reasons: CatalogReason[] };
  entitlement: Record<string, unknown> & { entitled: boolean; credential: string };
  deprecation: Record<string, unknown> & {
    deprecated: boolean;
    message: string | null;
    replace_with: string | null;
  };
  hidden: boolean;
  is_default: boolean;
  is_voice_default: boolean;
  is_user_defined: boolean;
};

export type ProviderDescriptor = Record<string, unknown> & {
  name: string;
  type: string;
  base_url: string | null;
  is_default_provider: boolean;
  is_user_defined: boolean;
  model_count: number;
  hidden_model_count: number;
  capabilities: Record<string, unknown> & { realtime: boolean; reasoning: boolean; modalities: string[] };
  health: Record<string, unknown> & { status: ProviderHealthStatus; detail: string | null };
};

export type CatalogSessionSelection = Record<string, unknown> & {
  session_id: string;
  active_model: string | null;
  reasoning_effort: string | null;
  /** Session approval reviewer ('user' | 'auto'); null on older runtimes. */
  approvals_reviewer: string | null;
};

export type ListModelsResult = Record<string, unknown> & {
  models: ModelDescriptor[];
  default_model: string | null;
  voice_default_model: string | null;
  errors: CatalogProviderError[];
  reasons: CatalogReason[];
  session?: CatalogSessionSelection;
};

export type GetModelResult = Record<string, unknown> & {
  found: boolean;
  model: ModelDescriptor | null;
  reasons: CatalogReason[];
};

export type ListProvidersResult = Record<string, unknown> & {
  providers: ProviderDescriptor[];
  errors: CatalogProviderError[];
  reasons: CatalogReason[];
};

export type SetSessionModelResult = Record<string, unknown> & {
  ok: boolean;
  session_id?: string;
  model?: string;
  label?: string;
  provider?: string;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  reasoning_effort?: string | null;
  warnings?: CatalogReason[];
  reasons?: CatalogReason[];
};

export type SetSessionReasoningResult = Record<string, unknown> & {
  ok: boolean;
  session_id?: string;
  reasoning_effort?: ReasoningEffort;
  model?: string | null;
  reasons?: CatalogReason[];
};

export type ListModelsOptions = {
  sessionId?: string;
  includeHidden?: boolean;
  modality?: string;
};

export class ModelCatalogProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCatalogProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelCatalogProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ModelCatalogProtocolError(`${label} must be a string`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length === 0) {
    throw new ModelCatalogProtocolError(`${label} must be non-empty`);
  }
  return result;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ModelCatalogProtocolError(`${label} must be a boolean`);
  }
  return value;
}

function nullableTokenLimit(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ModelCatalogProtocolError(`${label} must be a non-negative safe integer or null`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = nullableTokenLimit(value, label);
  if (result === null) {
    throw new ModelCatalogProtocolError(`${label} must not be null`);
  }
  return result;
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new ModelCatalogProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, nonEmptyString, label);
}

function optional<T>(
  source: Record<string, unknown>,
  field: string,
  parser: (value: unknown, label: string) => T,
  label: string
): { [key: string]: T } | Record<string, never> {
  return source[field] === undefined ? {} : { [field]: parser(source[field], `${label}.${field}`) };
}

function decodeReason(value: unknown, label: string): CatalogReason {
  const item = record(value, label);
  return {
    ...item,
    code: nonEmptyString(item.code, `${label}.code`),
    message: stringValue(item.message, `${label}.message`),
    ...optional(item, 'action', stringValue, label),
  } as CatalogReason;
}

function decodeProviderError(value: unknown, label: string): CatalogProviderError {
  const item = record(value, label);
  return {
    ...item,
    provider: nonEmptyString(item.provider, `${label}.provider`),
    code: nonEmptyString(item.code, `${label}.code`),
    message: stringValue(item.message, `${label}.message`),
  };
}

function decodeModel(value: unknown, label: string): ModelDescriptor {
  const item = record(value, label);
  const provider = record(item.provider, `${label}.provider`);
  const limits = record(item.limits, `${label}.limits`);
  const reasoning = record(item.reasoning, `${label}.reasoning`);
  const tiers = record(item.tiers, `${label}.tiers`);
  const personality = record(item.personality, `${label}.personality`);
  const availability = record(item.availability, `${label}.availability`);
  const entitlement = record(item.entitlement, `${label}.entitlement`);
  const deprecation = record(item.deprecation, `${label}.deprecation`);
  return {
    ...item,
    id: nonEmptyString(item.id, `${label}.id`),
    model: nullableString(item.model, `${label}.model`),
    label: stringValue(item.label, `${label}.label`),
    description: nullableString(item.description, `${label}.description`),
    provider: {
      ...provider,
      name: nullableString(provider.name, `${label}.provider.name`),
      type: nullableString(provider.type, `${label}.provider.type`),
    },
    modalities: stringArray(item.modalities, `${label}.modalities`),
    realtime: boolean(item.realtime, `${label}.realtime`),
    limits: {
      ...limits,
      max_input_tokens: nullableTokenLimit(limits.max_input_tokens, `${label}.limits.max_input_tokens`),
      max_output_tokens: nullableTokenLimit(limits.max_output_tokens, `${label}.limits.max_output_tokens`),
    },
    reasoning: {
      ...reasoning,
      default: nullableString(reasoning.default, `${label}.reasoning.default`),
      options: stringArray(reasoning.options, `${label}.reasoning.options`),
    },
    tiers: {
      ...tiers,
      service: nullableString(tiers.service, `${label}.tiers.service`),
      speed: nullableString(tiers.speed, `${label}.tiers.speed`),
    },
    personality: {
      ...personality,
      supported: boolean(personality.supported, `${label}.personality.supported`),
      options: stringArray(personality.options, `${label}.personality.options`),
      default: nullableString(personality.default, `${label}.personality.default`),
    },
    availability: {
      ...availability,
      available: boolean(availability.available, `${label}.availability.available`),
      reasons: array(availability.reasons, decodeReason, `${label}.availability.reasons`),
    },
    entitlement: {
      ...entitlement,
      entitled: boolean(entitlement.entitled, `${label}.entitlement.entitled`),
      credential: nonEmptyString(entitlement.credential, `${label}.entitlement.credential`),
    },
    deprecation: {
      ...deprecation,
      deprecated: boolean(deprecation.deprecated, `${label}.deprecation.deprecated`),
      message: nullableString(deprecation.message, `${label}.deprecation.message`),
      replace_with: nullableString(deprecation.replace_with, `${label}.deprecation.replace_with`),
    },
    hidden: boolean(item.hidden, `${label}.hidden`),
    is_default: boolean(item.is_default, `${label}.is_default`),
    is_voice_default: boolean(item.is_voice_default, `${label}.is_voice_default`),
    is_user_defined: boolean(item.is_user_defined, `${label}.is_user_defined`),
  };
}

function decodeProvider(value: unknown, label: string): ProviderDescriptor {
  const item = record(value, label);
  const capabilities = record(item.capabilities, `${label}.capabilities`);
  const health = record(item.health, `${label}.health`);
  const healthStatus = nonEmptyString(health.status, `${label}.health.status`);
  if (healthStatus !== 'ok' && healthStatus !== 'needs_auth' && healthStatus !== 'error') {
    throw new ModelCatalogProtocolError(`${label}.health.status has unsupported value ${JSON.stringify(healthStatus)}`);
  }
  return {
    ...item,
    name: nonEmptyString(item.name, `${label}.name`),
    type: nonEmptyString(item.type, `${label}.type`),
    base_url: nullableString(item.base_url, `${label}.base_url`),
    is_default_provider: boolean(item.is_default_provider, `${label}.is_default_provider`),
    is_user_defined: boolean(item.is_user_defined, `${label}.is_user_defined`),
    model_count: nonNegativeInteger(item.model_count, `${label}.model_count`),
    hidden_model_count: nonNegativeInteger(item.hidden_model_count, `${label}.hidden_model_count`),
    capabilities: {
      ...capabilities,
      realtime: boolean(capabilities.realtime, `${label}.capabilities.realtime`),
      reasoning: boolean(capabilities.reasoning, `${label}.capabilities.reasoning`),
      modalities: stringArray(capabilities.modalities, `${label}.capabilities.modalities`),
    },
    health: {
      ...health,
      status: healthStatus,
      detail: nullableString(health.detail, `${label}.health.detail`),
    },
  };
}

function decodeSession(value: unknown, label: string): CatalogSessionSelection {
  const item = record(value, label);
  return {
    ...item,
    session_id: nonEmptyString(item.session_id, `${label}.session_id`),
    active_model: nullableString(item.active_model, `${label}.active_model`),
    reasoning_effort: nullableString(item.reasoning_effort, `${label}.reasoning_effort`),
    approvals_reviewer:
      item.approvals_reviewer === undefined
        ? null
        : nullableString(item.approvals_reviewer, `${label}.approvals_reviewer`),
  };
}

function validateInput(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function decodeMutationBase(value: unknown, label: string, expectedSessionId: string): Record<string, unknown> {
  const item = record(value, label);
  const ok = boolean(item.ok, `${label}.ok`);
  if (item.session_id !== undefined && nonEmptyString(item.session_id, `${label}.session_id`) !== expectedSessionId) {
    throw new ModelCatalogProtocolError(`${label} returned a different session_id`);
  }
  return {
    ...item,
    ok,
    ...optional(item, 'session_id', nonEmptyString, label),
    ...(item.reasons === undefined ? {} : { reasons: array(item.reasons, decodeReason, `${label}.reasons`) }),
  };
}

export class ModelCatalogClient {
  constructor(private readonly rpc: ModelCatalogRpcTransport) {}

  async listModels(options: ListModelsOptions = {}): Promise<ListModelsResult> {
    const params: RpcMethodMap['list_models']['params'] = {};
    if (options.sessionId !== undefined) {
      params.session_id = validateInput(options.sessionId, 'sessionId');
    }
    if (options.includeHidden !== undefined) {
      if (typeof options.includeHidden !== 'boolean') {
        throw new TypeError('includeHidden must be a boolean');
      }
      params.include_hidden = options.includeHidden;
    }
    if (options.modality !== undefined) {
      params.modality = validateInput(options.modality, 'modality');
    }
    const raw = record(await this.rpc.request('list_models', params), 'list_models');
    const session = raw.session === undefined ? undefined : decodeSession(raw.session, 'list_models.session');
    const reasons = array(raw.reasons, decodeReason, 'list_models.reasons');
    if (params.session_id !== undefined && session !== undefined && session.session_id !== params.session_id) {
      throw new ModelCatalogProtocolError('list_models did not return the requested session selection');
    }
    if (params.session_id !== undefined && session === undefined && reasons.length === 0) {
      throw new ModelCatalogProtocolError('list_models did not return the requested session selection');
    }
    return {
      ...raw,
      models: array(raw.models, decodeModel, 'list_models.models'),
      default_model: nullableString(raw.default_model, 'list_models.default_model'),
      voice_default_model: nullableString(raw.voice_default_model, 'list_models.voice_default_model'),
      errors: array(raw.errors, decodeProviderError, 'list_models.errors'),
      reasons,
      ...(session === undefined ? {} : { session }),
    };
  }

  async getModel(model: string): Promise<GetModelResult> {
    const requestedModel = validateInput(model, 'model');
    const raw = record(await this.rpc.request('get_model', { model: requestedModel }), 'get_model');
    const found = boolean(raw.found, 'get_model.found');
    const descriptor = raw.model === null ? null : decodeModel(raw.model, 'get_model.model');
    if (found !== (descriptor !== null)) {
      throw new ModelCatalogProtocolError('get_model found flag does not match model presence');
    }
    return {
      ...raw,
      found,
      model: descriptor,
      reasons: array(raw.reasons, decodeReason, 'get_model.reasons'),
    };
  }

  async listProviders(): Promise<ListProvidersResult> {
    const raw = record(await this.rpc.request('list_providers', {}), 'list_providers');
    return {
      ...raw,
      providers: array(raw.providers, decodeProvider, 'list_providers.providers'),
      errors: array(raw.errors, decodeProviderError, 'list_providers.errors'),
      reasons: array(raw.reasons, decodeReason, 'list_providers.reasons'),
    };
  }

  async setSessionModel(sessionId: string, model: string): Promise<SetSessionModelResult> {
    const expectedSessionId = validateInput(sessionId, 'sessionId');
    const requestedModel = validateInput(model, 'model');
    const raw = decodeMutationBase(
      await this.rpc.request('set_session_model', { session_id: expectedSessionId, model: requestedModel }),
      'set_session_model',
      expectedSessionId
    );
    const ok = raw.ok as boolean;
    if (ok) {
      for (const field of [
        'session_id',
        'model',
        'label',
        'provider',
        'max_input_tokens',
        'max_output_tokens',
        'reasoning_effort',
        'warnings',
      ]) {
        if (raw[field] === undefined) {
          throw new ModelCatalogProtocolError(`set_session_model.${field} is required on success`);
        }
      }
    } else if (raw.reasons === undefined) {
      throw new ModelCatalogProtocolError('set_session_model.reasons is required on refusal');
    }
    return {
      ...raw,
      ok,
      ...optional(raw, 'model', nonEmptyString, 'set_session_model'),
      ...optional(raw, 'label', stringValue, 'set_session_model'),
      ...optional(raw, 'provider', nonEmptyString, 'set_session_model'),
      ...optional(raw, 'max_input_tokens', nullableTokenLimit, 'set_session_model'),
      ...optional(raw, 'max_output_tokens', nullableTokenLimit, 'set_session_model'),
      ...optional(raw, 'reasoning_effort', nullableString, 'set_session_model'),
      ...(raw.warnings === undefined
        ? {}
        : { warnings: array(raw.warnings, decodeReason, 'set_session_model.warnings') }),
    } as SetSessionModelResult;
  }

  async setSessionReasoning(sessionId: string, effort: ReasoningEffort): Promise<SetSessionReasoningResult> {
    const expectedSessionId = validateInput(sessionId, 'sessionId');
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh') {
      throw new TypeError('effort must be low, medium, high, or xhigh');
    }
    const raw = decodeMutationBase(
      await this.rpc.request('set_session_reasoning', { session_id: expectedSessionId, effort }),
      'set_session_reasoning',
      expectedSessionId
    );
    const ok = raw.ok as boolean;
    if (ok) {
      for (const field of ['session_id', 'reasoning_effort', 'model']) {
        if (raw[field] === undefined) {
          throw new ModelCatalogProtocolError(`set_session_reasoning.${field} is required on success`);
        }
      }
    } else if (raw.reasons === undefined) {
      throw new ModelCatalogProtocolError('set_session_reasoning.reasons is required on refusal');
    }
    let reasoningEffort: ReasoningEffort | undefined;
    if (raw.reasoning_effort !== undefined) {
      reasoningEffort = nonEmptyString(
        raw.reasoning_effort,
        'set_session_reasoning.reasoning_effort'
      ) as ReasoningEffort;
      if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
        throw new ModelCatalogProtocolError('set_session_reasoning returned an unsupported reasoning effort');
      }
    }
    return {
      ...raw,
      ok,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...optional(raw, 'model', nullableString, 'set_session_reasoning'),
    } as SetSessionReasoningResult;
  }
}
