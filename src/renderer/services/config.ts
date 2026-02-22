import { emitter } from '@/renderer/services/ipc';

export const configApi = {
  getOmniConfigDir: () => emitter.invoke('config:get-omni-config-dir'),
  getEnvFilePath: () => emitter.invoke('config:get-env-file-path'),
  readJsonFile: (path: string) => emitter.invoke('config:read-json-file', path),
  writeJsonFile: (path: string, data: unknown) => emitter.invoke('config:write-json-file', path, data),
  readTextFile: (path: string) => emitter.invoke('config:read-text-file', path),
  writeTextFile: (path: string, content: string) => emitter.invoke('config:write-text-file', path, content),
};
