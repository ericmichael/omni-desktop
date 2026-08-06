import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import {
  AgentHostManagementClient,
  AgentHostManagementProtocolError,
  type AgentHostManagementTransport,
} from '@/lib/agent-host-management';

type HostMethod = Extract<keyof RpcMethodMap, `agent_host_${string}`>;

const environment = (overrides: Record<string, unknown> = {}) => ({
  environment_id: 'env-1',
  workspace_id: 'workspace-1',
  kind: 'container',
  state: 'ready',
  generation: 3,
  capabilities: ['filesystem', 'terminal'],
  ...overrides,
});

class FakeHostRpc implements AgentHostManagementTransport {
  readonly calls: Array<{ method: HostMethod; params: unknown }> = [];
  readonly request = vi.fn(
    async <Method extends HostMethod>(
      method: Method,
      params: RpcMethodMap[Method]['params']
    ): Promise<RpcMethodMap[Method]['result']> => {
      this.calls.push({ method, params });
      return this.results[method] as RpcMethodMap[Method]['result'];
    }
  );

  constructor(private readonly results: Partial<Record<HostMethod, unknown>>) {}
}

describe('AgentHostManagementClient', () => {
  it('registers workspaces and profiles with exact generated request shapes', async () => {
    const rpc = new FakeHostRpc({
      agent_host_register_workspace: {
        workspace_id: 'workspace-1',
        owner_user_id: 'user-1',
        snapshot_ref: 'snapshot-1',
        sources: [{ kind: 'local' }],
        future_workspace_field: true,
      },
      agent_host_register_profile: {
        profile_id: 'profile-1',
        definition: { kind: 'default' },
        future_profile_field: true,
      },
    });
    const client = new AgentHostManagementClient(rpc);

    await client.registerWorkspace({
      workspaceId: 'workspace-1',
      materializationPath: '/workspace',
      snapshotRef: 'snapshot-1',
      sources: [{ kind: 'local' }],
      ownerUserId: 'user-1',
    });
    const profile = await client.registerProfile('profile-1', { kind: 'default' }, 'user-1');

    expect(rpc.calls).toEqual([
      {
        method: 'agent_host_register_workspace',
        params: {
          workspace_id: 'workspace-1',
          materialization_path: '/workspace',
          snapshot_ref: 'snapshot-1',
          sources: [{ kind: 'local' }],
          owner_user_id: 'user-1',
        },
      },
      {
        method: 'agent_host_register_profile',
        params: { profile_id: 'profile-1', definition: { kind: 'default' }, owner_user_id: 'user-1' },
      },
    ]);
    expect(profile).toMatchObject({ future_profile_field: true });
  });

  it('lists and runtime-validates all registered resource classes', async () => {
    const rpc = new FakeHostRpc({
      agent_host_list_resources: {
        agent_host_id: 'host-1',
        workspaces: [
          {
            workspace_id: 'workspace-1',
            owner_user_id: null,
            snapshot_ref: null,
            sources: [],
          },
        ],
        profiles: { 'profile-1': { kind: 'default', future_definition_field: 1 } },
        environments: [environment({ future_environment_field: 'kept' })],
        future_resources_field: true,
      },
    });

    const result = await new AgentHostManagementClient(rpc).listResources();
    expect(rpc.calls).toEqual([{ method: 'agent_host_list_resources', params: {} }]);
    expect(result).toMatchObject({
      agent_host_id: 'host-1',
      profiles: { 'profile-1': { future_definition_field: 1 } },
      environments: [{ generation: 3, future_environment_field: 'kept' }],
      future_resources_field: true,
    });
  });

  it('materializes an environment into a complete generation-aware ExecutionTarget', async () => {
    const rpc = new FakeHostRpc({
      agent_host_materialize_environment: {
        ...environment(),
        backend: 'docker',
        container_id: 'container-1',
        services: { app: 'http://127.0.0.1:3000' },
        workspace_root: '/workspace',
        default_cwd: '/workspace',
      },
    });

    const result = await new AgentHostManagementClient(rpc).materializeEnvironment('workspace-1', 'profile-1');
    expect(rpc.calls).toEqual([
      {
        method: 'agent_host_materialize_environment',
        params: { workspace_id: 'workspace-1', profile_id: 'profile-1' },
      },
    ]);
    expect(result.executionTarget).toEqual({
      workspaceId: 'workspace-1',
      environmentId: 'env-1',
      environmentGeneration: 3,
    });
  });

  it('requires and correlates the complete target when stopping an environment', async () => {
    const rpc = new FakeHostRpc({ agent_host_stop_environment: environment({ state: 'stopped' }) });
    const client = new AgentHostManagementClient(rpc);
    const target = { workspaceId: 'workspace-1', environmentId: 'env-1', environmentGeneration: 3 };

    await expect(client.stopEnvironment(target)).resolves.toMatchObject({ state: 'stopped', generation: 3 });
    expect(rpc.calls).toEqual([{ method: 'agent_host_stop_environment', params: { environment_id: 'env-1' } }]);

    const stale = new AgentHostManagementClient(
      new FakeHostRpc({ agent_host_stop_environment: environment({ generation: 4 }) })
    );
    await expect(stale.stopEnvironment(target)).rejects.toThrow(/different environment generation/);
  });

  it('binds threads and rejects response identity drift', async () => {
    const rpc = new FakeHostRpc({
      agent_host_bind_thread: {
        thread_id: 'thread-1',
        workspace_id: 'workspace-1',
        environment_selection: { mode: 'existing', environment_id: 'env-1' },
      },
    });
    const client = new AgentHostManagementClient(rpc);
    await expect(
      client.bindThread('thread-1', 'workspace-1', { mode: 'existing', environment_id: 'env-1' })
    ).resolves.toMatchObject({ thread_id: 'thread-1' });

    const wrong = new AgentHostManagementClient(
      new FakeHostRpc({
        agent_host_bind_thread: {
          thread_id: 'other',
          workspace_id: 'workspace-1',
          environment_selection: { mode: 'none' },
        },
      })
    );
    await expect(wrong.bindThread('thread-1', 'workspace-1', { mode: 'none' })).rejects.toThrow(
      /different resource identifiers/
    );
  });

  it.each([
    ['zero generation', environment({ generation: 0 }), /generation must be a positive/],
    ['missing capabilities', environment({ capabilities: undefined }), /capabilities must be an array/],
    ['empty environment id', environment({ environment_id: '' }), /environment_id must be a non-empty/],
  ])('rejects malformed environment descriptors: %s', async (_name, payload, message) => {
    const client = new AgentHostManagementClient(
      new FakeHostRpc({
        agent_host_list_resources: {
          agent_host_id: 'host-1',
          workspaces: [],
          profiles: {},
          environments: [payload],
        },
      })
    );
    await expect(client.listResources()).rejects.toThrow(message);
  });

  it('uses protocol errors for malformed server results', async () => {
    const client = new AgentHostManagementClient(
      new FakeHostRpc({ agent_host_list_resources: { agent_host_id: 'host-1' } })
    );
    await expect(client.listResources()).rejects.toBeInstanceOf(AgentHostManagementProtocolError);
  });
});
