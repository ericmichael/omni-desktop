import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';
import { AccountManagementClient } from '@/renderer/omniagents-ui/rpc/account-management';
import { LayeredConfigClient } from '@/renderer/omniagents-ui/rpc/layered-config';
import { McpManagementClient } from '@/renderer/omniagents-ui/rpc/mcp-management';
import { emitter } from '@/renderer/services/ipc';
import { isManagementAdminMethod, type ManagementAdminRequest } from '@/shared/management-admin';

/** Renderer facade over the closed main-process mutation broker. It reuses
 * the strict protocol decoders but deliberately exposes no read methods and
 * no generic call escape hatch. */
class AdminTransport {
  async request<Method extends keyof RpcMethodMap>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    if (!isManagementAdminMethod(method)) {
      throw new TypeError(`${String(method)} is not an allowed management mutation`);
    }
    return (await emitter.invoke('management-runtime:mutate', {
      method,
      params,
    } as ManagementAdminRequest)) as RpcMethodMap[Method]['result'];
  }
}

const transport = new AdminTransport();
const accounts = new AccountManagementClient(transport);
const mcp = new McpManagementClient(transport);
const config = new LayeredConfigClient(
  transport,
  (operation) => operation === 'validate_config' || operation === 'write_config'
);

export const managementAdminApi = {
  validateConfig: (updates: Record<string, unknown>) => config.validate(updates),
  writeConfig: (updates: Record<string, unknown>) => config.write(updates),

  startAccountLogin: (
    provider: string,
    mode: 'device_code' | 'browser' | 'api_key',
    options?: { apiKey?: string; redirectUri?: string }
  ) => accounts.startLogin(provider, mode, options),
  completeAccountLogin: (loginId: string, code?: string) => accounts.completeLogin(loginId, code),
  cancelAccountLogin: (loginId: string) => accounts.cancelLogin(loginId),
  logoutAccount: (provider: string) => accounts.logout(provider),
  refreshAccount: (provider: string) => accounts.refresh(provider),
  selectAccount: (provider: string) => accounts.select(provider),

  createMcpServer: (input: Parameters<McpManagementClient['createServer']>[0]) => mcp.createServer(input),
  updateMcpServer: (serverName: string, updates: Parameters<McpManagementClient['updateServer']>[1]) =>
    mcp.updateServer(serverName, updates),
  deleteMcpServer: (serverName: string) => mcp.deleteServer(serverName),
  reloadMcpServer: (serverName?: string) => mcp.reloadServer(serverName),
  startMcpAuth: (serverName: string, options?: Parameters<McpManagementClient['startAuth']>[1]) =>
    mcp.startAuth(serverName, options),
  completeMcpAuth: (authId: string, code: string) => mcp.completeAuth(authId, code),
  cancelMcpAuth: (authId: string) => mcp.cancelAuth(authId),
};
