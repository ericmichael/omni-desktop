import type { InitializeResult, RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

type InitializeParams = RpcMethodMap['initialize']['params'];
export type OmniagentsRpcCapabilities = InitializeParams['capabilities'];

const BASE_CAPABILITIES: OmniagentsRpcCapabilities = {
  realtime: false,
  mcp_apps: false,
  client_functions: false,
  approvals: false,
  artifacts: false,
  replay: false,
  terminal: false,
  experimental_operations: [],
  disabled_notifications: [],
};

export function mainRpcInitializeParams(
  name: string,
  capabilities: Partial<OmniagentsRpcCapabilities> = {}
): InitializeParams {
  return {
    protocol_version: '1.0.0',
    identity: { name, version: '1.0.0' },
    platform: { os: process.platform, arch: process.arch },
    capabilities: { ...BASE_CAPABILITIES, ...capabilities },
  };
}

/**
 * Promote an open WebSocket transport into an initialized OmniAgents GUI RPC
 * connection. Main-process clients must await this boundary before sending any
 * feature request; a raw `open` event is intentionally not application-ready.
 */
export async function initializeMainRpcConnection(options: {
  name: string;
  capabilities?: Partial<OmniagentsRpcCapabilities>;
  request: (method: 'initialize', params: InitializeParams) => Promise<unknown>;
  notify: (method: 'initialized', params: Record<string, never>) => void | Promise<void>;
}): Promise<InitializeResult> {
  const initialized = (await options.request(
    'initialize',
    mainRpcInitializeParams(options.name, options.capabilities)
  )) as InitializeResult;
  await options.notify('initialized', {});
  return initialized;
}
