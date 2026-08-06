import { describe, expect, it } from 'vitest';

import { assertManagementAdminRequest, isManagementAdminMethod, MANAGEMENT_ADMIN_METHODS } from './management-admin';

describe('management admin allowlist', () => {
  it('contains only the intended config, account, and MCP mutations', () => {
    expect(MANAGEMENT_ADMIN_METHODS).toContain('write_config');
    expect(MANAGEMENT_ADMIN_METHODS).toContain('account_login_start');
    expect(MANAGEMENT_ADMIN_METHODS).toContain('mcp_update_server');
    expect(isManagementAdminMethod('list_models')).toBe(false);
    expect(isManagementAdminMethod('agent_host_list_resources')).toBe(false);
  });

  it('rejects malformed and arbitrary IPC requests', () => {
    expect(() => assertManagementAdminRequest(null)).toThrow('must be an object');
    expect(() => assertManagementAdminRequest({ method: 'server_call', params: {} })).toThrow('not allowed');
    expect(() => assertManagementAdminRequest({ method: 'write_config', params: [] })).toThrow(
      'params must be an object'
    );
    expect(assertManagementAdminRequest({ method: 'write_config', params: { updates: { enabled: true } } })).toEqual({
      method: 'write_config',
      params: { updates: { enabled: true } },
    });
  });
});
