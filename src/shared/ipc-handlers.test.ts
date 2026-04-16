import { describe, expect, it } from 'vitest';

import { MAX_USER_PATH_DEPTH } from '@/main/util';
import { registerConfigHandlers, registerUtilHandlers } from '@/shared/ipc-handlers';
import { StubIpc } from '@/test-helpers/stub-ipc';

describe('registerConfigHandlers', () => {
  it('registers the expected config channels', () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    expect(ipc.handlers.has('config:get-omni-config-dir')).toBe(true);
    expect(ipc.handlers.has('config:get-env-file-path')).toBe(true);
    expect(ipc.handlers.has('config:read-json-file')).toBe(true);
    expect(ipc.handlers.has('config:write-json-file')).toBe(true);
    expect(ipc.handlers.has('config:read-text-file')).toBe(true);
    expect(ipc.handlers.has('config:write-text-file')).toBe(true);
  });

  it('validateConfigPath is enforced on read-json-file', async () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    // A path outside the config dir must be rejected.
    await expect(ipc.invoke('config:read-json-file', '/etc/passwd')).rejects.toThrow();
  });

  it('validateConfigPath is enforced on write-text-file', async () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    await expect(ipc.invoke('config:write-text-file', '/etc/shadow', 'evil')).rejects.toThrow();
  });

  it('config:get-omni-config-dir returns the supplied dir', () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    expect(ipc.invoke('config:get-omni-config-dir')).toBe('/tmp/omni-config');
  });
});

describe('registerUtilHandlers — path validation', () => {
  const buildIpc = (): StubIpc => {
    const ipc = new StubIpc();
    registerUtilHandlers(ipc, {
      // eslint-disable-next-line @typescript-eslint/require-await
      fetchFn: (async () => new Response()) as unknown as typeof globalThis.fetch,
      launcherVersion: 'test',
    });
    return ipc;
  };

  it('util:ensure-directory rejects null bytes', async () => {
    const ipc = buildIpc();
    await expect(ipc.invoke('util:ensure-directory', '/tmp/foo\0bar')).rejects.toThrow(/null byte/);
  });

  it('util:list-directory rejects null bytes', async () => {
    const ipc = buildIpc();
    await expect(ipc.invoke('util:list-directory', '/tmp/foo\0bar')).rejects.toThrow(/null byte/);
  });

  it('util:get-is-directory rejects null bytes', async () => {
    const ipc = buildIpc();
    await expect(ipc.invoke('util:get-is-directory', '/tmp/foo\0bar')).rejects.toThrow(/null byte/);
  });

  it('util:get-is-file rejects null bytes', async () => {
    const ipc = buildIpc();
    await expect(ipc.invoke('util:get-is-file', '/tmp/foo\0bar')).rejects.toThrow(/null byte/);
  });

  it('util:get-path-exists rejects null bytes', async () => {
    const ipc = buildIpc();
    await expect(ipc.invoke('util:get-path-exists', '/tmp/foo\0bar')).rejects.toThrow(/null byte/);
  });

  it('util:ensure-directory rejects excessively deep paths', async () => {
    const ipc = buildIpc();
    const tooDeep = '/' + 'a/'.repeat(MAX_USER_PATH_DEPTH + 5) + 'leaf';
    await expect(ipc.invoke('util:ensure-directory', tooDeep)).rejects.toThrow(/maximum depth/);
  });

  it('util:list-directory does NOT enforce depth (read-only)', async () => {
    const ipc = buildIpc();
    // Read-only operations are not constrained by depth — just by null byte.
    // Using a non-existent deep path so the readdir try/catch returns [].
    const deep = '/' + 'a/'.repeat(MAX_USER_PATH_DEPTH + 5) + 'leaf';
    await expect(ipc.invoke('util:list-directory', deep)).resolves.toEqual([]);
  });

  it('util:list-directory accepts paths outside the user home (DirectoryBrowserDialog use case)', async () => {
    const ipc = buildIpc();
    // /tmp is a perfectly legitimate workspace location — the validator
    // must NOT constrain to $HOME or any specific root.
    await expect(ipc.invoke('util:list-directory', '/tmp')).resolves.toBeDefined();
  });
});
