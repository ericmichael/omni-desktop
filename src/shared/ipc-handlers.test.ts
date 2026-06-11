import { describe, expect, it } from 'vitest';

import { MAX_USER_PATH_DEPTH } from '@/main/util';
import { registerConfigHandlers, registerUtilHandlers, validateProvider } from '@/shared/ipc-handlers';
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

describe('validateProvider', () => {
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchStub = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
    (async (url: RequestInfo | URL, init?: RequestInit) =>
      impl(String(url), init)) as unknown as typeof globalThis.fetch;

  it('openai: parses the /v1/models data array and sends the bearer header', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const fetchFn = fetchStub((url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)['Authorization'] ?? '';
      return jsonResponse(200, { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.1-mini' }] });
    });
    const result = await validateProvider(fetchFn, { kind: 'openai', apiKey: 'sk-test' });
    expect(seenUrl).toBe('https://api.openai.com/v1/models');
    expect(seenAuth).toBe('Bearer sk-test');
    expect(result).toEqual({ ok: true, models: ['gpt-5.5', 'gpt-5.1-mini'] });
  });

  it('anthropic: sends x-api-key + anthropic-version headers', async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchFn = fetchStub((_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return jsonResponse(200, { data: [{ id: 'claude-fable-5' }] });
    });
    const result = await validateProvider(fetchFn, { kind: 'anthropic', apiKey: 'sk-ant-test' });
    expect(seenHeaders['x-api-key']).toBe('sk-ant-test');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
    expect(result).toEqual({ ok: true, models: ['claude-fable-5'] });
  });

  it('ollama: hits /api/tags on the default port and parses model names', async () => {
    let seenUrl = '';
    const fetchFn = fetchStub((url) => {
      seenUrl = url;
      return jsonResponse(200, { models: [{ name: 'llama3.1:8b' }, { name: 'qwen3:14b' }] });
    });
    const result = await validateProvider(fetchFn, { kind: 'ollama' });
    expect(seenUrl).toBe('http://localhost:11434/api/tags');
    expect(result).toEqual({ ok: true, models: ['llama3.1:8b', 'qwen3:14b'] });
  });

  it('openai-compatible: normalizes the base URL to /v1/models and requires a base URL', async () => {
    let seenUrl = '';
    const fetchFn = fetchStub((url) => {
      seenUrl = url;
      return jsonResponse(200, { data: [{ id: 'my-model' }] });
    });
    const ok = await validateProvider(fetchFn, { kind: 'openai-compatible', baseUrl: 'http://localhost:8000/' });
    expect(seenUrl).toBe('http://localhost:8000/v1/models');
    expect(ok).toEqual({ ok: true, models: ['my-model'] });

    const missing = await validateProvider(fetchFn, { kind: 'openai-compatible' });
    expect(missing).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('maps 401/403 to unauthorized and 404 to not-found', async () => {
    const unauthorized = await validateProvider(
      fetchStub(() => jsonResponse(401, {})),
      { kind: 'openai', apiKey: 'sk-bad' }
    );
    expect(unauthorized).toMatchObject({ ok: false, code: 'unauthorized' });

    const forbidden = await validateProvider(
      fetchStub(() => jsonResponse(403, {})),
      { kind: 'anthropic', apiKey: 'sk-bad' }
    );
    expect(forbidden).toMatchObject({ ok: false, code: 'unauthorized' });

    const notFound = await validateProvider(
      fetchStub(() => jsonResponse(404, {})),
      { kind: 'openai-compatible', baseUrl: 'http://localhost:9' }
    );
    expect(notFound).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('maps fetch failures to network errors', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const result = await validateProvider(fetchFn, { kind: 'ollama' });
    expect(result).toMatchObject({ ok: false, code: 'network' });
  });

  it('maps malformed bodies to unknown', async () => {
    const fetchFn = fetchStub(() => new Response('not json', { status: 200 }));
    const result = await validateProvider(fetchFn, { kind: 'openai', apiKey: 'sk-test' });
    expect(result).toMatchObject({ ok: false, code: 'unknown' });
  });
});
