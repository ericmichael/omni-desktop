import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

type ConfigMethod = Extract<keyof RpcMethodMap, 'get_config' | 'validate_config' | 'write_config'>;
export interface LayeredConfigTransport {
  request<Method extends ConfigMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
}
export type ReloadMode = 'hot' | 'session' | 'restart';
export type ConfigFieldType = 'string' | 'boolean' | 'integer' | 'string_list';
export type ConfigLayer = Record<string, unknown> & {
  name: string;
  writable: boolean;
  sources: string[];
  write_target?: string;
};
export type ConfigFieldLayer = Record<string, unknown> & {
  layer: string;
  source: string | null;
  is_set: boolean;
  value?: unknown;
};
export type ConfigField = Record<string, unknown> & {
  key: string;
  type: ConfigFieldType;
  label: string;
  description: string;
  secret: boolean;
  reload: ReloadMode;
  read_only: boolean;
  read_only_reason: string | null;
  is_set: boolean;
  effective_layer: string | null;
  layers: ConfigFieldLayer[];
  allowed_values?: string[];
  minimum?: number;
  maximum?: number;
  value?: unknown;
};
export type ConfigError = Record<string, unknown> & { key: string; code: string; message: string };
export type ReloadSummary = Record<string, unknown> & { hot: string[]; session: string[]; restart: string[] };

export class LayeredConfigProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayeredConfigProtocolError';
  }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LayeredConfigProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LayeredConfigProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LayeredConfigProtocolError(`${label} must be a boolean`);
  }
  return value;
}
function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LayeredConfigProtocolError(`${label} must be a finite number`);
  }
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}
function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new LayeredConfigProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}
const strings = (value: unknown, label: string) => array(value, string, label);
function decodeReload(value: unknown, label: string): ReloadSummary {
  const item = record(value, label);
  return {
    ...item,
    hot: strings(item.hot, `${label}.hot`),
    session: strings(item.session, `${label}.session`),
    restart: strings(item.restart, `${label}.restart`),
  };
}
function decodeLayer(value: unknown, label: string): ConfigLayer {
  const item = record(value, label);
  return {
    ...item,
    name: string(item.name, `${label}.name`),
    writable: bool(item.writable, `${label}.writable`),
    sources: strings(item.sources, `${label}.sources`),
    ...(item.write_target === undefined ? {} : { write_target: string(item.write_target, `${label}.write_target`) }),
  };
}
function decodeFieldLayer(value: unknown, label: string, secret: boolean): ConfigFieldLayer {
  const item = record(value, label);
  if (secret && Object.hasOwn(item, 'value')) {
    throw new LayeredConfigProtocolError(`${label} exposes a secret value`);
  }
  return {
    ...item,
    layer: string(item.layer, `${label}.layer`),
    source: nullableString(item.source, `${label}.source`),
    is_set: bool(item.is_set, `${label}.is_set`),
  };
}
function decodeField(value: unknown, label: string): ConfigField {
  const item = record(value, label);
  const secret = bool(item.secret, `${label}.secret`);
  if (secret && Object.hasOwn(item, 'value')) {
    throw new LayeredConfigProtocolError(`${label} exposes a secret value`);
  }
  const reload = string(item.reload, `${label}.reload`);
  if (reload !== 'hot' && reload !== 'session' && reload !== 'restart') {
    throw new LayeredConfigProtocolError(`${label}.reload is unsupported`);
  }
  const readOnly = bool(item.read_only, `${label}.read_only`);
  const readOnlyReason = nullableString(item.read_only_reason, `${label}.read_only_reason`);
  if (readOnly !== (readOnlyReason !== null)) {
    throw new LayeredConfigProtocolError(`${label}.read_only disagrees with read_only_reason`);
  }
  const isSet = bool(item.is_set, `${label}.is_set`);
  const effectiveLayer = nullableString(item.effective_layer, `${label}.effective_layer`);
  if (isSet !== (effectiveLayer !== null)) {
    throw new LayeredConfigProtocolError(`${label}.is_set disagrees with effective_layer`);
  }
  const type = string(item.type, `${label}.type`);
  if (type !== 'string' && type !== 'boolean' && type !== 'integer' && type !== 'string_list') {
    throw new LayeredConfigProtocolError(`${label}.type is unsupported`);
  }
  return {
    ...item,
    key: string(item.key, `${label}.key`),
    type,
    label: string(item.label, `${label}.label`),
    description:
      typeof item.description === 'string'
        ? item.description
        : (() => {
            throw new LayeredConfigProtocolError(`${label}.description must be a string`);
          })(),
    secret,
    reload,
    read_only: readOnly,
    read_only_reason: readOnlyReason,
    is_set: isSet,
    effective_layer: effectiveLayer,
    layers: array(item.layers, (entry, entryLabel) => decodeFieldLayer(entry, entryLabel, secret), `${label}.layers`),
    ...(item.allowed_values === undefined
      ? {}
      : { allowed_values: strings(item.allowed_values, `${label}.allowed_values`) }),
    ...(item.minimum === undefined ? {} : { minimum: finiteNumber(item.minimum, `${label}.minimum`) }),
    ...(item.maximum === undefined ? {} : { maximum: finiteNumber(item.maximum, `${label}.maximum`) }),
  };
}
function decodeError(value: unknown, label: string): ConfigError {
  const item = record(value, label);
  if (Object.hasOwn(item, 'value')) {
    throw new LayeredConfigProtocolError(`${label} echoes a submitted value`);
  }
  return {
    ...item,
    key: string(item.key, `${label}.key`),
    code: string(item.code, `${label}.code`),
    message:
      typeof item.message === 'string'
        ? item.message
        : (() => {
            throw new LayeredConfigProtocolError(`${label}.message must be a string`);
          })(),
  };
}

export class LayeredConfigClient {
  constructor(
    private readonly rpc: LayeredConfigTransport,
    private readonly supportsExperimentalOperation: (operation: string) => boolean = () => true
  ) {}
  async getConfig(): Promise<Record<string, unknown> & { layers: ConfigLayer[]; fields: ConfigField[] }> {
    this.requireExperimentalOperation('get_config');
    const raw = record(await this.rpc.request('get_config', {}), 'get_config');
    return {
      ...raw,
      layers: array(raw.layers, decodeLayer, 'get_config.layers'),
      fields: array(raw.fields, decodeField, 'get_config.fields'),
    };
  }
  async validate(
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown> & { valid: boolean; errors: ConfigError[]; reload: ReloadSummary }> {
    this.requireExperimentalOperation('validate_config');
    const raw = record(await this.rpc.request('validate_config', { updates }), 'validate_config');
    const errors = array(raw.errors, decodeError, 'validate_config.errors');
    const valid = bool(raw.valid, 'validate_config.valid');
    if (valid !== (errors.length === 0)) {
      throw new LayeredConfigProtocolError('validate_config validity disagrees with errors');
    }
    return { ...raw, valid, errors, reload: decodeReload(raw.reload, 'validate_config.reload') };
  }
  async write(updates: Record<string, unknown>): Promise<
    Record<string, unknown> & {
      ok: boolean;
      errors: ConfigError[];
      written: string[];
      cleared: string[];
      reload: ReloadSummary;
      restart_required: boolean;
      fields: ConfigField[];
    }
  > {
    this.requireExperimentalOperation('write_config');
    const raw = record(await this.rpc.request('write_config', { updates }), 'write_config');
    const ok = bool(raw.ok, 'write_config.ok');
    const errors = array(raw.errors, decodeError, 'write_config.errors');
    if (ok !== (errors.length === 0)) {
      throw new LayeredConfigProtocolError('write_config status disagrees with errors');
    }
    const reload = decodeReload(raw.reload, 'write_config.reload');
    const restartRequired = bool(raw.restart_required, 'write_config.restart_required');
    if (restartRequired !== reload.restart.length > 0) {
      throw new LayeredConfigProtocolError('write_config restart_required disagrees with reload.restart');
    }
    return {
      ...raw,
      ok,
      errors,
      written: strings(raw.written, 'write_config.written'),
      cleared: strings(raw.cleared, 'write_config.cleared'),
      reload,
      restart_required: restartRequired,
      fields: array(raw.fields, decodeField, 'write_config.fields'),
    };
  }

  private requireExperimentalOperation(operation: string): void {
    if (!this.supportsExperimentalOperation(operation)) {
      throw new LayeredConfigProtocolError(`${operation} was not negotiated for this connection`);
    }
  }
}
