import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import type { ExecutionTarget } from '@/shared/types';

type AgentHostMethod = Extract<keyof RpcMethodMap, `agent_host_${string}`>;

export interface AgentHostManagementTransport {
  request<Method extends AgentHostMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
}

export type AgentHostWorkspace = Record<string, unknown> & {
  workspace_id: string;
  owner_user_id: string | null;
  snapshot_ref: string | null;
  sources: Record<string, unknown>[];
};

export type AgentHostEnvironment = Record<string, unknown> & {
  environment_id: string;
  workspace_id: string;
  kind: string;
  state: string;
  generation: number;
  capabilities: string[];
};

export type MaterializedEnvironment = AgentHostEnvironment & {
  backend: string | null;
  container_id: string | null;
  services: Record<string, string>;
  workspace_root: string;
  default_cwd: string;
  executionTarget: ExecutionTarget;
};

export type AgentHostResources = Record<string, unknown> & {
  agent_host_id: string;
  workspaces: AgentHostWorkspace[];
  profiles: Record<string, Record<string, unknown>>;
  environments: AgentHostEnvironment[];
};

export type ThreadEnvironmentBinding =
  | { mode: 'none' }
  | { mode: 'automatic'; profile_id: string }
  | { mode: 'existing'; environment_id: string };

export type BoundThread = Record<string, unknown> & {
  thread_id: string;
  workspace_id: string | null;
  environment_selection: ThreadEnvironmentBinding;
};

export class AgentHostManagementProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHostManagementProtocolError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentHostManagementProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentHostManagementProtocolError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function generation(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AgentHostManagementProtocolError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function array<T>(value: unknown, parser: (entry: unknown, label: string) => T, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new AgentHostManagementProtocolError(`${label} must be an array`);
  }
  return value.map((entry, index) => parser(entry, `${label}[${index}]`));
}

function decodeWorkspace(value: unknown, label: string): AgentHostWorkspace {
  const item = record(value, label);
  return {
    ...item,
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    owner_user_id: nullableString(item.owner_user_id, `${label}.owner_user_id`),
    snapshot_ref: nullableString(item.snapshot_ref, `${label}.snapshot_ref`),
    sources: array(item.sources, record, `${label}.sources`),
  };
}

function decodeEnvironment(value: unknown, label: string): AgentHostEnvironment {
  const item = record(value, label);
  return {
    ...item,
    environment_id: nonEmptyString(item.environment_id, `${label}.environment_id`),
    workspace_id: nonEmptyString(item.workspace_id, `${label}.workspace_id`),
    kind: nonEmptyString(item.kind, `${label}.kind`),
    state: nonEmptyString(item.state, `${label}.state`),
    generation: generation(item.generation, `${label}.generation`),
    capabilities: array(item.capabilities, nonEmptyString, `${label}.capabilities`),
  };
}

function decodeBinding(value: unknown, label: string): ThreadEnvironmentBinding {
  const item = record(value, label);
  const mode = nonEmptyString(item.mode, `${label}.mode`);
  if (mode === 'none') {
    return { mode };
  }
  if (mode === 'automatic') {
    return { mode, profile_id: nonEmptyString(item.profile_id, `${label}.profile_id`) };
  }
  if (mode === 'existing') {
    return { mode, environment_id: nonEmptyString(item.environment_id, `${label}.environment_id`) };
  }
  throw new AgentHostManagementProtocolError(`${label}.mode has unsupported value ${JSON.stringify(mode)}`);
}

function validateInput(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateTarget(target: ExecutionTarget): ExecutionTarget {
  validateInput(target.workspaceId, 'target.workspaceId');
  validateInput(target.environmentId, 'target.environmentId');
  generation(target.environmentGeneration, 'target.environmentGeneration');
  return target;
}

export class AgentHostManagementClient {
  constructor(private readonly rpc: AgentHostManagementTransport) {}

  async registerWorkspace(input: {
    workspaceId: string;
    materializationPath: string;
    snapshotRef?: string;
    sources?: readonly Record<string, unknown>[];
    ownerUserId?: string;
  }): Promise<AgentHostWorkspace> {
    const workspaceId = validateInput(input.workspaceId, 'workspaceId');
    const raw = await this.rpc.request('agent_host_register_workspace', {
      workspace_id: workspaceId,
      materialization_path: validateInput(input.materializationPath, 'materializationPath'),
      ...(input.snapshotRef === undefined ? {} : { snapshot_ref: validateInput(input.snapshotRef, 'snapshotRef') }),
      ...(input.sources === undefined ? {} : { sources: [...input.sources] }),
      ...(input.ownerUserId === undefined ? {} : { owner_user_id: validateInput(input.ownerUserId, 'ownerUserId') }),
    });
    const result = decodeWorkspace(raw, 'agent_host_register_workspace');
    if (result.workspace_id !== workspaceId) {
      throw new AgentHostManagementProtocolError('register_workspace returned a different workspace_id');
    }
    return result;
  }

  async registerProfile(
    profileId: string,
    definition: Record<string, unknown>,
    ownerUserId?: string
  ): Promise<Record<string, unknown> & { profile_id: string; definition: Record<string, unknown> }> {
    const expectedProfileId = validateInput(profileId, 'profileId');
    const raw = record(
      await this.rpc.request('agent_host_register_profile', {
        profile_id: expectedProfileId,
        definition,
        ...(ownerUserId === undefined ? {} : { owner_user_id: validateInput(ownerUserId, 'ownerUserId') }),
      }),
      'agent_host_register_profile'
    );
    const resultProfileId = nonEmptyString(raw.profile_id, 'agent_host_register_profile.profile_id');
    if (resultProfileId !== expectedProfileId) {
      throw new AgentHostManagementProtocolError('register_profile returned a different profile_id');
    }
    return { ...raw, profile_id: resultProfileId, definition: record(raw.definition, 'profile definition') };
  }

  async listResources(): Promise<AgentHostResources> {
    const raw = record(await this.rpc.request('agent_host_list_resources', {}), 'agent_host_list_resources');
    const profiles = record(raw.profiles, 'agent_host_list_resources.profiles');
    return {
      ...raw,
      agent_host_id: nonEmptyString(raw.agent_host_id, 'agent_host_list_resources.agent_host_id'),
      workspaces: array(raw.workspaces, decodeWorkspace, 'agent_host_list_resources.workspaces'),
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([profileId, definition]) => [
          nonEmptyString(profileId, 'profile id'),
          record(definition, `profile ${profileId}`),
        ])
      ),
      environments: array(raw.environments, decodeEnvironment, 'agent_host_list_resources.environments'),
    };
  }

  async materializeEnvironment(workspaceId: string, profileId: string): Promise<MaterializedEnvironment> {
    const expectedWorkspaceId = validateInput(workspaceId, 'workspaceId');
    const raw = record(
      await this.rpc.request('agent_host_materialize_environment', {
        workspace_id: expectedWorkspaceId,
        profile_id: validateInput(profileId, 'profileId'),
      }),
      'agent_host_materialize_environment'
    );
    const environment = decodeEnvironment(raw, 'agent_host_materialize_environment');
    if (environment.workspace_id !== expectedWorkspaceId) {
      throw new AgentHostManagementProtocolError('materialize_environment returned a different workspace_id');
    }
    if (environment.state !== 'ready') {
      throw new AgentHostManagementProtocolError('materialize_environment did not return a ready environment');
    }
    const services = record(raw.services, 'materialized environment services');
    const executionTarget: ExecutionTarget = {
      workspaceId: environment.workspace_id,
      environmentId: environment.environment_id,
      environmentGeneration: environment.generation,
    };
    return {
      ...environment,
      backend: nullableString(raw.backend, 'materialized environment backend'),
      container_id: nullableString(raw.container_id, 'materialized environment container_id'),
      services: Object.fromEntries(
        Object.entries(services).map(([name, url]) => [name, nonEmptyString(url, `service ${name}`)])
      ),
      workspace_root: nonEmptyString(raw.workspace_root, 'materialized environment workspace_root'),
      default_cwd: nonEmptyString(raw.default_cwd, 'materialized environment default_cwd'),
      executionTarget,
    };
  }

  async stopEnvironment(target: ExecutionTarget): Promise<AgentHostEnvironment> {
    const expected = validateTarget(target);
    // Protocol v2 currently accepts only environment_id on this mutation.
    // Requiring the complete target here and validating the returned generation
    // prevents Desktop from silently accepting a stale/replaced environment.
    const result = decodeEnvironment(
      await this.rpc.request('agent_host_stop_environment', { environment_id: expected.environmentId }),
      'agent_host_stop_environment'
    );
    if (
      result.environment_id !== expected.environmentId ||
      result.workspace_id !== expected.workspaceId ||
      result.generation !== expected.environmentGeneration
    ) {
      throw new AgentHostManagementProtocolError('stop_environment returned a different environment generation');
    }
    if (result.state !== 'stopped') {
      throw new AgentHostManagementProtocolError('stop_environment did not return a stopped environment');
    }
    return result;
  }

  async bindThread(
    threadId: string,
    workspaceId: string | null,
    environmentSelection: ThreadEnvironmentBinding
  ): Promise<BoundThread> {
    const expectedThreadId = validateInput(threadId, 'threadId');
    const binding = {
      workspace_id: workspaceId === null ? null : validateInput(workspaceId, 'workspaceId'),
      environment_selection: decodeBinding(environmentSelection, 'environmentSelection'),
    };
    const raw = record(
      await this.rpc.request('agent_host_bind_thread', { thread_id: expectedThreadId, binding }),
      'agent_host_bind_thread'
    );
    const resultThreadId = nonEmptyString(raw.thread_id, 'agent_host_bind_thread.thread_id');
    const resultWorkspaceId = nullableString(raw.workspace_id, 'agent_host_bind_thread.workspace_id');
    if (resultThreadId !== expectedThreadId || resultWorkspaceId !== workspaceId) {
      throw new AgentHostManagementProtocolError('bind_thread returned different resource identifiers');
    }
    return {
      ...raw,
      thread_id: resultThreadId,
      workspace_id: resultWorkspaceId,
      environment_selection: decodeBinding(raw.environment_selection, 'agent_host_bind_thread.environment_selection'),
    };
  }
}
