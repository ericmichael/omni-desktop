import type { RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

/**
 * Process-wide Omniagents mutations permitted through the main/server admin
 * broker. Reads stay on the renderer's ordinary consumer credential. Keeping
 * this list closed prevents an IPC caller from turning the broker into a
 * generic control-token tunnel.
 */
export const MANAGEMENT_ADMIN_METHODS = [
  'validate_config',
  'write_config',
  'account_login_start',
  'account_login_complete',
  'account_login_cancel',
  'account_logout',
  'account_refresh',
  'account_select',
  'mcp_create_server',
  'mcp_update_server',
  'mcp_delete_server',
  'mcp_reload_server',
  'mcp_auth_start',
  'mcp_auth_complete',
  'mcp_auth_cancel',
] as const satisfies readonly (keyof RpcMethodMap)[];

export type ManagementAdminMethod = (typeof MANAGEMENT_ADMIN_METHODS)[number];

export type ManagementAdminRequest = {
  [Method in ManagementAdminMethod]: {
    method: Method;
    params: RpcMethodMap[Method]['params'];
  };
}[ManagementAdminMethod];

export type ManagementAdminResult = RpcMethodMap[ManagementAdminMethod]['result'];

const methodSet = new Set<string>(MANAGEMENT_ADMIN_METHODS);

export const isManagementAdminMethod = (value: unknown): value is ManagementAdminMethod =>
  typeof value === 'string' && methodSet.has(value);

export const assertManagementAdminRequest = (value: unknown): ManagementAdminRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Management admin request must be an object');
  }
  const request = value as { method?: unknown; params?: unknown };
  if (!isManagementAdminMethod(request.method)) {
    throw new TypeError('Management admin method is not allowed');
  }
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new TypeError('Management admin params must be an object');
  }
  return request as ManagementAdminRequest;
};
