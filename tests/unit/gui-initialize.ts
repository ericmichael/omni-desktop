import { GUI_PROTOCOL_VERSION, type InitializeResult } from '@/generated/omniagents-gui-v2/gui-v2';

export function guiInitializeResult(overrides: Partial<InitializeResult> = {}): InitializeResult {
  return {
    protocol_version: GUI_PROTOCOL_VERSION,
    identity: { name: 'test-server', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64' },
    capabilities: {
      realtime: false,
      mcp_apps: false,
      client_functions: false,
      approvals: false,
      artifacts: false,
      replay: false,
      terminal: false,
      experimental_operations: [],
      disabled_notifications: [],
    },
    agent_host: { agent_host_id: 'test-host' },
    ...overrides,
  };
}
