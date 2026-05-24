import { emitter } from '@/renderer/services/ipc';
import type { McpConfig, ModelsConfig, NetworkConfig } from '@/shared/types';

export const configApi = {
  getOmniConfigDir: () => emitter.invoke('config:get-omni-config-dir'),
  getEnvFilePath: () => emitter.invoke('config:get-env-file-path'),
  readJsonFile: (path: string) => emitter.invoke('config:read-json-file', path),
  writeJsonFile: (path: string, data: unknown) => emitter.invoke('config:write-json-file', path, data),
  readTextFile: (path: string) => emitter.invoke('config:read-text-file', path),
  writeTextFile: (path: string, content: string) => emitter.invoke('config:write-text-file', path, content),
};

/**
 * Typed agent-config API — the source of truth is the (per-tenant, in cloud)
 * store, not a file path. Replaces the four Settings tabs' `config:*` file I/O;
 * the backend persists the value and re-materializes the agent's on-disk config.
 */
export const agentConfigApi = {
  getModels: () => emitter.invoke('settings:get-models-config'),
  setModels: (config: ModelsConfig) => emitter.invoke('settings:set-models-config', config),
  getMcp: () => emitter.invoke('settings:get-mcp-config'),
  setMcp: (config: McpConfig) => emitter.invoke('settings:set-mcp-config', config),
  getNetwork: () => emitter.invoke('settings:get-network-config'),
  setNetwork: (config: NetworkConfig) => emitter.invoke('settings:set-network-config', config),
  getEnv: () => emitter.invoke('settings:get-env'),
  setEnv: (content: string) => emitter.invoke('settings:set-env', content),
};
