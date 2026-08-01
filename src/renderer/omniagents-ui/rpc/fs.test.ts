import { describe, expect, it, vi } from 'vitest';

import type { RpcMethodMap, RpcNotificationMap } from '@/generated/omniagents-gui-v1/gui-v1';

import type { RPCConnectionState } from './client';
import {
  DEFAULT_TEXT_FILE_LIMIT_BYTES,
  type FileSystemRpcTransport,
  FsClient,
  FsFileTooLargeError,
  type FsListResult,
  FsPathValidationError,
  FsProtocolError,
  validateFsPath,
  WatchRegistry,
} from './fs';

type FsMethod = Extract<keyof RpcMethodMap, `fs_${string}`>;

class FakeRpc {
  connectionState: RPCConnectionState = 'connected';
  readonly calls: Array<{ method: FsMethod; params: unknown }> = [];
  responder: (method: FsMethod, params: any) => unknown | Promise<unknown> = () => ({});
  private readonly eventHandlers = new Map<string, Set<(payload: any) => void>>();
  private readonly stateHandlers = new Set<(state: RPCConnectionState) => void>();

  async request<Method extends FsMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']> {
    this.calls.push({ method, params });
    return (await this.responder(method, params)) as RpcMethodMap[Method]['result'];
  }

  on<Event extends keyof RpcNotificationMap>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void {
    const handlers = this.eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  onConnectionState(handler: (state: RPCConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.connectionState);
    return () => this.stateHandlers.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      handler(payload);
    }
  }

  setState(state: RPCConnectionState): void {
    this.connectionState = state;
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }
}

const sha256Hello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function downloadResponder(bytes: Uint8Array, sha256 = sha256Hello) {
  return (method: FsMethod, params: any): unknown => {
    if (method === 'fs_download_open') {
      return {
        transfer_id: 'download-1',
        session_id: 'session',
        path: params.path,
        size: bytes.byteLength,
        mime: 'text/plain',
        mtime: 123,
        sha256,
        chunk_size: 256 * 1024,
      };
    }
    if (method === 'fs_download_read') {
      const chunk = bytes.subarray(params.offset, params.offset + params.length);
      return {
        transfer_id: params.transfer_id,
        offset: params.offset,
        data: btoa(String.fromCharCode(...chunk)),
        bytes: chunk.byteLength,
        eof: params.offset + chunk.byteLength === bytes.byteLength,
        size: bytes.byteLength,
      };
    }
    if (method === 'fs_download_close') {
      return true;
    }
    return {};
  };
}

describe('FsClient', () => {
  it('accepts only canonical workspace-relative POSIX paths before sending requests', async () => {
    expect(validateFsPath('.')).toBe('.');
    expect(validateFsPath('.hidden/src.ts')).toBe('.hidden/src.ts');
    for (const path of [
      '',
      '/',
      '/tmp/file',
      'C:/file',
      'src\\file',
      'src//file',
      'src/',
      './src',
      'src/.',
      'src/..',
      'src\0file',
    ]) {
      expect(() => validateFsPath(path)).toThrow(FsPathValidationError);
    }

    const rpc = new FakeRpc();
    const client = new FsClient(rpc as FileSystemRpcTransport);
    await expect(client.list('session', '../outside')).rejects.toBeInstanceOf(FsPathValidationError);
    await expect(client.stat('session', '/etc/passwd')).rejects.toBeInstanceOf(FsPathValidationError);
    await expect(client.watch('session', 'src\\nested')).rejects.toBeInstanceOf(FsPathValidationError);
    await expect(client.downloadBytes('session', 'src//file')).rejects.toBeInstanceOf(FsPathValidationError);
    await expect(client.uploadBytes('session', 'C:/file', new Uint8Array())).rejects.toBeInstanceOf(
      FsPathValidationError
    );
    expect(rpc.calls).toEqual([]);
    client.dispose();
  });

  it('strictly parses list/stat results including nullable directory metadata', async () => {
    const rpc = new FakeRpc();
    rpc.responder = (method) => {
      if (method === 'fs_list') {
        return {
          path: '.',
          writable: true,
          truncated: false,
          entries: [{ path: 'src', type: 'directory', size: null, mtime: null, writable: true }],
        };
      }
      return { path: 'src', type: 'directory', size: null, mtime: null, writable: true };
    };
    const client = new FsClient(rpc as FileSystemRpcTransport);

    await expect(client.list('session', '.')).resolves.toMatchObject({ entries: [{ path: 'src', size: null }] });
    await expect(client.stat('session', 'src')).resolves.toMatchObject({ type: 'directory', mime: null });

    rpc.responder = () => ({ path: '.', writable: true, truncated: false, entries: [{ path: 'bad', type: 'pipe' }] });
    await expect(client.list('session', '.')).rejects.toBeInstanceOf(FsProtocolError);
    client.dispose();
  });

  it('rejects wrong list/stat echoes and out-of-scope nested result paths', async () => {
    const rpc = new FakeRpc();
    const client = new FsClient(rpc as FileSystemRpcTransport);

    rpc.responder = () => ({ path: 'other', writable: true, truncated: false, entries: [] });
    await expect(client.list('session', 'src')).rejects.toBeInstanceOf(FsProtocolError);

    rpc.responder = () => ({ path: 'other', type: 'directory', size: null, mtime: null, writable: true });
    await expect(client.stat('session', 'src')).rejects.toBeInstanceOf(FsProtocolError);

    rpc.responder = () => ({
      path: 'src',
      writable: true,
      truncated: false,
      entries: [{ path: '../outside', type: 'file', size: 1, mtime: 1, writable: false }],
    });
    await expect(client.list('session', 'src')).rejects.toBeInstanceOf(FsPathValidationError);
    client.dispose();
  });

  it('downloads with explicit offsets, validates the digest, and always closes', async () => {
    const rpc = new FakeRpc();
    rpc.responder = downloadResponder(new TextEncoder().encode('hello'));
    const client = new FsClient(rpc as FileSystemRpcTransport);

    const result = await client.downloadBytes('session', 'hello.txt');

    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(rpc.calls.map((call) => call.method)).toEqual(['fs_download_open', 'fs_download_read', 'fs_download_close']);
    expect(rpc.calls[1]!.params).toMatchObject({ offset: 0, length: 5 });
    client.dispose();
  });

  it('reopens a download after reconnect and resumes from the explicit offset', async () => {
    const rpc = new FakeRpc();
    const bytes = new TextEncoder().encode('hello');
    let openCount = 0;
    let readCount = 0;
    rpc.responder = (method, params) => {
      if (method === 'fs_download_open') {
        openCount += 1;
        return {
          transfer_id: `download-${openCount}`,
          session_id: 'session',
          path: 'hello.txt',
          size: 5,
          mime: 'text/plain',
          mtime: 123,
          sha256: sha256Hello,
          chunk_size: 256 * 1024,
        };
      }
      if (method === 'fs_download_read') {
        readCount += 1;
        if (readCount === 1) {
          return { transfer_id: 'download-1', offset: 0, data: 'aGU=', bytes: 2, eof: false, size: 5 };
        }
        if (readCount === 2) {
          rpc.setState('reconnecting');
          queueMicrotask(() => rpc.setState('connected'));
          throw new Error('socket closed');
        }
        const chunk = bytes.subarray(params.offset);
        return {
          transfer_id: `download-${openCount}`,
          offset: params.offset,
          data: btoa(String.fromCharCode(...chunk)),
          bytes: chunk.byteLength,
          eof: true,
          size: 5,
        };
      }
      if (method === 'fs_download_close') {
        return true;
      }
      return {};
    };
    const client = new FsClient(rpc as FileSystemRpcTransport);

    const result = await client.downloadBytes('session', 'hello.txt');

    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(openCount).toBe(2);
    const secondTransferRead = rpc.calls.find(
      (call) => call.method === 'fs_download_read' && (call.params as any).transfer_id === 'download-2'
    );
    expect(secondTransferRead?.params).toMatchObject({ offset: 2 });
    client.dispose();
  });

  it('refuses content above the explicit text safety limit before reading chunks', async () => {
    const rpc = new FakeRpc();
    rpc.responder = (method) =>
      method === 'fs_download_open'
        ? {
            transfer_id: 'large',
            session_id: 'session',
            path: 'large.txt',
            size: DEFAULT_TEXT_FILE_LIMIT_BYTES + 1,
            mime: 'text/plain',
            mtime: 1,
            sha256: sha256Hello,
            chunk_size: 256 * 1024,
          }
        : true;
    const client = new FsClient(rpc as FileSystemRpcTransport);

    await expect(client.readTextFile('session', 'large.txt')).rejects.toBeInstanceOf(FsFileTooLargeError);
    expect(rpc.calls.some((call) => call.method === 'fs_download_read')).toBe(false);
    client.dispose();
  });

  it('detects UTF-8 BOM, mixed newlines, invalid UTF-8, and binary NULs', async () => {
    const cases: Array<{ bytes: Uint8Array; expected: unknown }> = [
      {
        bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a\r\nb\n')]),
        expected: { kind: 'text', encoding: 'utf-8-bom', newline: 'mixed', trailingNewline: true },
      },
      {
        bytes: new Uint8Array([0xc3, 0x28]),
        expected: { kind: 'binary', reason: 'invalid-utf8' },
      },
      {
        bytes: new Uint8Array([0x61, 0, 0x62]),
        expected: { kind: 'binary', reason: 'nul-byte' },
      },
    ];

    for (const testCase of cases) {
      const rpc = new FakeRpc();
      rpc.responder = downloadResponder(testCase.bytes, await digest(testCase.bytes));
      const client = new FsClient(rpc as FileSystemRpcTransport);
      await expect(client.readTextFile('session', 'file')).resolves.toMatchObject(testCase.expected as object);
      client.dispose();
    }
  });

  it('computes the new-content digest and keeps expected_sha256 as a distinct write precondition', async () => {
    const rpc = new FakeRpc();
    const existingDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    rpc.responder = (method, params) => {
      if (method === 'fs_upload_open') {
        return { transfer_id: 'upload-1', session_id: 'session', path: 'file.txt', chunk_size: 256 * 1024 };
      }
      if (method === 'fs_upload_chunk') {
        return { transfer_id: 'upload-1', received: atob(params.data).length, size: 5 };
      }
      if (method === 'fs_upload_commit') {
        return { path: 'file.txt', size: 5, sha256: sha256Hello };
      }
      if (method === 'fs_upload_abort') {
        return true;
      }
      return {};
    };
    const client = new FsClient(rpc as FileSystemRpcTransport);

    await expect(
      client.writeTextFile('session', 'file.txt', 'hello', { expectedSha256: existingDigest })
    ).resolves.toEqual({ path: 'file.txt', size: 5, sha256: sha256Hello });

    const opened = rpc.calls.find((call) => call.method === 'fs_upload_open')!.params;
    expect(opened).toMatchObject({ sha256: sha256Hello, expected_sha256: existingDigest });
    expect((opened as any).sha256).not.toBe((opened as any).expected_sha256);
    client.dispose();
  });

  it('restarts an upload from offset zero with a fresh transfer after reconnect', async () => {
    const rpc = new FakeRpc();
    let openCount = 0;
    let firstChunk = true;
    rpc.responder = (method, params) => {
      if (method === 'fs_upload_open') {
        openCount += 1;
        return {
          transfer_id: `upload-${openCount}`,
          session_id: 'session',
          path: 'file.txt',
          chunk_size: 256 * 1024,
        };
      }
      if (method === 'fs_upload_chunk' && firstChunk) {
        firstChunk = false;
        rpc.setState('reconnecting');
        queueMicrotask(() => rpc.setState('connected'));
        throw new Error('socket closed');
      }
      if (method === 'fs_upload_chunk') {
        return { transfer_id: params.transfer_id, received: 5, size: 5 };
      }
      if (method === 'fs_upload_commit') {
        return { path: 'file.txt', size: 5, sha256: sha256Hello };
      }
      if (method === 'fs_upload_abort') {
        return true;
      }
      return {};
    };
    const client = new FsClient(rpc as FileSystemRpcTransport);

    await expect(client.writeTextFile('session', 'file.txt', 'hello')).resolves.toMatchObject({ sha256: sha256Hello });

    expect(openCount).toBe(2);
    expect(
      rpc.calls.filter((call) => call.method === 'fs_upload_chunk').map((call) => (call.params as any).offset)
    ).toEqual([0, 0]);
    expect(
      rpc.calls.filter((call) => call.method === 'fs_upload_chunk').map((call) => (call.params as any).transfer_id)
    ).toEqual(['upload-1', 'upload-2']);
    client.dispose();
  });

  it('aborts a failed upload and rejects malformed server boundaries', async () => {
    const rpc = new FakeRpc();
    rpc.responder = (method) => {
      if (method === 'fs_upload_open') {
        return { transfer_id: 'upload-1' };
      }
      if (method === 'fs_upload_chunk') {
        return { transfer_id: 'upload-1', received: 'not-a-number', size: 5 };
      }
      if (method === 'fs_upload_abort') {
        return true;
      }
      return {};
    };
    const client = new FsClient(rpc as FileSystemRpcTransport);

    await expect(client.writeTextFile('session', 'file.txt', 'hello')).rejects.toBeInstanceOf(FsProtocolError);
    expect(rpc.calls.at(-1)?.method).toBe('fs_upload_abort');
    client.dispose();
  });
});

const listing: FsListResult = { path: '.', writable: true, entries: [], truncated: false };

class FakeWatchClient {
  state: RPCConnectionState = 'connected';
  watchCounter = 0;
  readonly calls: string[] = [];
  private readonly events = new Map<string, Set<(payload: any) => void>>();
  private readonly states = new Set<(state: RPCConnectionState) => void>();

  async watch(_sessionId: string, path: string): Promise<string> {
    this.calls.push(`watch:${path}`);
    return `watch-${++this.watchCounter}`;
  }
  async unwatch(_sessionId: string, watchId: string): Promise<void> {
    this.calls.push(`unwatch:${watchId}`);
  }
  async list(_sessionId: string, path: string, recursive = false): Promise<FsListResult> {
    this.calls.push(`list:${path}:${recursive}`);
    return { ...listing, path };
  }
  on(event: string, handler: (payload: any) => void): () => void {
    const handlers = this.events.get(event) ?? new Set();
    handlers.add(handler);
    this.events.set(event, handlers);
    return () => handlers.delete(handler);
  }
  onConnectionState(handler: (state: RPCConnectionState) => void): () => void {
    this.states.add(handler);
    handler(this.state);
    return () => this.states.delete(handler);
  }
  emit(event: string, payload: unknown): void {
    for (const handler of this.events.get(event) ?? []) {
      handler(payload);
    }
  }
  setState(state: RPCConnectionState): void {
    this.state = state;
    for (const handler of this.states) {
      handler(state);
    }
  }
}

describe('WatchRegistry', () => {
  it('uses non-recursive watches and preserves ordered delete/create type changes', async () => {
    const client = new FakeWatchClient();
    const registry = new WatchRegistry(client, 'session');
    const onEvents = vi.fn();
    const onError = vi.fn();
    const unsubscribe = await registry.subscribe('.', { onEvents, onError });

    client.emit('fs_events', {
      session_id: 'session',
      watch_id: 'watch-1',
      events: [
        { type: 'deleted', path: 'node', entry_type: 'file' },
        { type: 'created', path: 'node', entry_type: 'directory' },
      ],
    });

    expect(client.calls.slice(0, 2)).toEqual(['watch:.', 'list:.:false']);
    expect(onEvents).toHaveBeenCalledWith([
      { type: 'deleted', path: 'node', entryType: 'file' },
      { type: 'created', path: 'node', entryType: 'directory' },
    ]);
    client.emit('fs_events', {
      session_id: 'session',
      watch_id: 'watch-1',
      events: [{ type: 'created', path: '../outside', entry_type: 'file' }],
    });
    expect(onEvents).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(FsPathValidationError));
    await unsubscribe();
    await registry.dispose();
  });

  it('re-subscribes and relists every desired directory after reconnect', async () => {
    const client = new FakeWatchClient();
    const registry = new WatchRegistry(client, 'session');
    const onRescan = vi.fn();
    await registry.subscribe('src', { onRescan });
    client.calls.length = 0;

    client.setState('reconnecting');
    client.setState('connected');

    await vi.waitFor(() => expect(client.calls).toEqual(['watch:src', 'list:src:false']));
    expect(onRescan).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src' }), 'reconnect');
    await registry.dispose();
  });

  it('relists on overflow but does not reuse a terminated scan-limit watch', async () => {
    const client = new FakeWatchClient();
    const registry = new WatchRegistry(client, 'session');
    const onRescan = vi.fn();
    const onNarrowerWatchRequired = vi.fn();
    await registry.subscribe('.', { onRescan, onNarrowerWatchRequired });
    client.calls.length = 0;

    client.emit('fs_rescan_required', {
      session_id: 'session',
      watch_id: 'watch-1',
      reason: 'event_overflow',
    });
    await vi.waitFor(() => expect(client.calls).toEqual(['list:.:false']));
    expect(onRescan).toHaveBeenLastCalledWith(expect.anything(), 'event_overflow');

    client.emit('fs_rescan_required', {
      session_id: 'session',
      watch_id: 'watch-1',
      reason: 'scan_limit_exceeded',
    });
    await vi.waitFor(() => expect(client.calls).toEqual(['list:.:false', 'list:.:false']));
    expect(onNarrowerWatchRequired).toHaveBeenCalledOnce();

    client.setState('reconnecting');
    client.setState('connected');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.calls.filter((call) => call.startsWith('watch:'))).toEqual([]);
    await registry.dispose();
  });

  it('evicts the least-recently-used directory before reaching the server watch budget', async () => {
    const client = new FakeWatchClient();
    const registry = new WatchRegistry(client, 'session', 2);
    const evicted = vi.fn();
    await registry.subscribe('a', { onEvicted: evicted });
    await registry.subscribe('b', {});
    await registry.subscribe('c', {});

    expect(registry.size).toBe(2);
    expect(evicted).toHaveBeenCalledOnce();
    expect(client.calls).toContain('unwatch:watch-1');
    await registry.dispose();
  });
});
