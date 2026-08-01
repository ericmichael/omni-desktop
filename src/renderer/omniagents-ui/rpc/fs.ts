import type {
  FsEventsParams,
  FsRescanRequiredParams,
  RpcMethodMap,
  RpcNotificationMap,
} from '@/generated/omniagents-gui-v1/gui-v1';

import type { RPCConnectionState } from './client';

export const FS_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_TEXT_FILE_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_BINARY_FILE_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_CLIENT_FILE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_WATCH_LIMIT = 24;
export const MAX_CLIENT_WATCHES = 31;

type FsMethod = Extract<keyof RpcMethodMap, `fs_${string}`>;

export interface FileSystemRpcTransport {
  readonly connectionState: RPCConnectionState;
  request<Method extends FsMethod>(
    method: Method,
    params: RpcMethodMap[Method]['params']
  ): Promise<RpcMethodMap[Method]['result']>;
  on<Event extends keyof RpcNotificationMap>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void;
  onConnectionState(handler: (state: RPCConnectionState) => void): () => void;
}

export type FsEntryType = 'file' | 'directory';

export interface FsEntry {
  path: string;
  type: FsEntryType;
  size: number | null;
  mtime: number | null;
  writable: boolean;
}

export interface FsListResult {
  path: string;
  writable: boolean;
  entries: FsEntry[];
  truncated: boolean;
}

export interface FsStatResult {
  path: string;
  type: FsEntryType;
  size: number | null;
  mtime: number | null;
  mime: string | null;
  writable: boolean;
}

export interface FsDownloadResult {
  path: string;
  size: number;
  bytes: Uint8Array;
  sha256: string;
  mime: string | null;
  mtime: number | null;
}

export interface FsUploadResult {
  path: string;
  size: number;
  sha256: string;
}

export type NewlineStyle = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

interface TextFileMetadata {
  path: string;
  size: number;
  sha256: string;
  mime: string | null;
  mtime: number | null;
}

export type TextFileReadResult =
  | (TextFileMetadata & {
      kind: 'text';
      text: string;
      encoding: 'utf-8' | 'utf-8-bom';
      newline: NewlineStyle;
      trailingNewline: boolean;
    })
  | (TextFileMetadata & {
      kind: 'binary';
      reason: 'nul-byte' | 'invalid-utf8' | 'control-characters';
    });

export interface TransferOptions {
  maxBytes?: number;
  reconnectRetries?: number;
  reconnectTimeoutMs?: number;
}

export interface UploadOptions extends TransferOptions {
  overwrite?: boolean;
  /** Digest of the existing target. This is distinct from the new bytes' digest. */
  expectedSha256?: string;
}

export interface WriteTextOptions extends UploadOptions {
  newline?: Exclude<NewlineStyle, 'none' | 'mixed'>;
  bom?: boolean;
}

export class FsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsProtocolError';
  }
}

export class FsFileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number
  ) {
    super(`File is ${size} bytes; client safety limit is ${limit} bytes`);
    this.name = 'FsFileTooLargeError';
  }
}

export class FsPathValidationError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(`Invalid workspace path ${JSON.stringify(path)}: ${message}`);
    this.name = 'FsPathValidationError';
  }
}

/**
 * Require the canonical workspace-relative POSIX spelling used on the wire.
 * Root is represented only by `.`; all other paths are non-empty segments
 * without aliases, traversal, platform separators, or drive prefixes.
 */
export function validateFsPath(path: string): string {
  if (path === '.') {
    return path;
  }
  if (path.length === 0) {
    throw new FsPathValidationError(path, 'path is empty');
  }
  if (path.includes('\0')) {
    throw new FsPathValidationError(path, 'NUL bytes are forbidden');
  }
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new FsPathValidationError(path, 'path must be workspace-relative');
  }
  if (path.includes('\\')) {
    throw new FsPathValidationError(path, 'backslashes are forbidden');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '')) {
    throw new FsPathValidationError(path, 'empty path segments are forbidden');
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new FsPathValidationError(path, 'dot and parent segments are forbidden');
  }
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FsProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, label: string): string {
  if (typeof value[field] !== 'string') {
    throw new FsProtocolError(`${label}.${field} must be a string`);
  }
  return value[field];
}

function numberField(value: Record<string, unknown>, field: string, label: string): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) {
    throw new FsProtocolError(`${label}.${field} must be a non-negative finite number`);
  }
  return result;
}

function nullableNumberField(value: Record<string, unknown>, field: string, label: string): number | null {
  if (value[field] == null) {
    return null;
  }
  return numberField(value, field, label);
}

function booleanField(value: Record<string, unknown>, field: string, label: string): boolean {
  if (typeof value[field] !== 'boolean') {
    throw new FsProtocolError(`${label}.${field} must be a boolean`);
  }
  return value[field];
}

function nullableStringField(value: Record<string, unknown>, field: string, label: string): string | null {
  const result = value[field];
  if (result == null) {
    return null;
  }
  if (typeof result !== 'string') {
    throw new FsProtocolError(`${label}.${field} must be a string or null`);
  }
  return result;
}

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CLIENT_FILE_BYTES) {
    throw new RangeError(`maxBytes must be an integer between 0 and ${MAX_CLIENT_FILE_BYTES}`);
  }
  return limit;
}

function validateTransferOptions(options: TransferOptions): { retries: number; timeoutMs: number } {
  const retries = options.reconnectRetries ?? 2;
  const timeoutMs = options.reconnectTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) {
    throw new RangeError('reconnectRetries must be an integer between 0 and 10');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new RangeError('reconnectTimeoutMs must be an integer between 1 and 300000');
  }
  return { retries, timeoutMs };
}

function validateChunkSize(value: Record<string, unknown>, label: string): number {
  const chunkSize = numberField(value, 'chunk_size', label);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > FS_CHUNK_BYTES) {
    throw new FsProtocolError(`${label}.chunk_size must be an integer between 1 and ${FS_CHUNK_BYTES}`);
  }
  return chunkSize;
}

function validateSha256(value: string, label: string): string {
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new FsProtocolError(`${label} must be a 64-character hexadecimal SHA-256 digest`);
  }
  return value.toLowerCase();
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new FsProtocolError('fs_download_read.data must be valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseList(value: unknown): FsListResult {
  const result = record(value, 'fs_list result');
  if (!Array.isArray(result.entries)) {
    throw new FsProtocolError('fs_list result.entries must be an array');
  }
  const entries = result.entries.map((item, index) => {
    const entry = record(item, `fs_list result.entries[${index}]`);
    const type = stringField(entry, 'type', `fs_list result.entries[${index}]`);
    if (type !== 'file' && type !== 'directory') {
      throw new FsProtocolError(`fs_list result.entries[${index}].type is unsupported`);
    }
    return {
      path: validateFsPath(stringField(entry, 'path', `fs_list result.entries[${index}]`)),
      type: type as FsEntryType,
      size: nullableNumberField(entry, 'size', `fs_list result.entries[${index}]`),
      mtime: nullableNumberField(entry, 'mtime', `fs_list result.entries[${index}]`),
      writable: booleanField(entry, 'writable', `fs_list result.entries[${index}]`),
    };
  });
  return {
    path: validateFsPath(stringField(result, 'path', 'fs_list result')),
    writable: booleanField(result, 'writable', 'fs_list result'),
    entries,
    truncated: booleanField(result, 'truncated', 'fs_list result'),
  };
}

function parseStat(value: unknown): FsStatResult {
  const result = record(value, 'fs_stat result');
  const type = stringField(result, 'type', 'fs_stat result');
  if (type !== 'file' && type !== 'directory') {
    throw new FsProtocolError('fs_stat result.type is unsupported');
  }
  return {
    path: validateFsPath(stringField(result, 'path', 'fs_stat result')),
    type,
    size: nullableNumberField(result, 'size', 'fs_stat result'),
    mtime: nullableNumberField(result, 'mtime', 'fs_stat result'),
    mime: nullableStringField(result, 'mime', 'fs_stat result'),
    writable: booleanField(result, 'writable', 'fs_stat result'),
  };
}

type BinaryReason = 'nul-byte' | 'invalid-utf8' | 'control-characters';

function detectBinary(bytes: Uint8Array): Exclude<BinaryReason, 'invalid-utf8'> | null {
  if (bytes.includes(0)) {
    return 'nul-byte';
  }
  let controls = 0;
  const sampleLength = Math.min(bytes.length, 8 * 1024);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index]!;
    if (
      (byte < 0x20 && byte !== 0x08 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) ||
      byte === 0x7f
    ) {
      controls += 1;
    }
  }
  return sampleLength > 0 && controls / sampleLength > 0.1 ? 'control-characters' : null;
}

export function detectNewlineStyle(text: string): { newline: NewlineStyle; trailingNewline: boolean } {
  const styles = new Set<Exclude<NewlineStyle, 'none' | 'mixed'>>();
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    styles.add(match[0] === '\r\n' ? 'crlf' : match[0] === '\r' ? 'cr' : 'lf');
  }
  return {
    newline: styles.size === 0 ? 'none' : styles.size === 1 ? [...styles][0]! : 'mixed',
    trailingNewline: /(?:\r\n|\r|\n)$/.test(text),
  };
}

function normalizeNewlines(text: string, newline: Exclude<NewlineStyle, 'none' | 'mixed'>): string {
  const sequence = newline === 'crlf' ? '\r\n' : newline === 'cr' ? '\r' : '\n';
  return text.replace(/\r\n|\r|\n/g, sequence);
}

function isRetryableDisconnect(transport: FileSystemRpcTransport, startEpoch: number, currentEpoch: number): boolean {
  return transport.connectionState !== 'connected' || startEpoch !== currentEpoch;
}

export class FsClient {
  private connectionEpoch = 0;
  private previousState: RPCConnectionState;
  private readonly unsubscribeConnection: () => void;

  constructor(private readonly rpc: FileSystemRpcTransport) {
    this.previousState = rpc.connectionState;
    this.unsubscribeConnection = rpc.onConnectionState((state) => {
      if (state === 'connected' && this.previousState !== 'connected') {
        this.connectionEpoch += 1;
      }
      this.previousState = state;
    });
  }

  dispose(): void {
    this.unsubscribeConnection();
  }

  onConnectionState(handler: (state: RPCConnectionState) => void): () => void {
    return this.rpc.onConnectionState(handler);
  }

  on<Event extends 'fs_events' | 'fs_rescan_required'>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void {
    return this.rpc.on(event, handler);
  }

  async list(sessionId: string, path: string, recursive = false): Promise<FsListResult> {
    const requestedPath = validateFsPath(path);
    const result = parseList(
      await this.rpc.request('fs_list', { session_id: sessionId, path: requestedPath, recursive })
    );
    if (result.path !== requestedPath) {
      throw new FsProtocolError('fs_list returned the wrong path');
    }
    return result;
  }

  async stat(sessionId: string, path: string): Promise<FsStatResult> {
    const requestedPath = validateFsPath(path);
    const result = parseStat(await this.rpc.request('fs_stat', { session_id: sessionId, path: requestedPath }));
    if (result.path !== requestedPath) {
      throw new FsProtocolError('fs_stat returned the wrong path');
    }
    return result;
  }

  async watch(sessionId: string, path: string): Promise<string> {
    const requestedPath = validateFsPath(path);
    const result = record(
      await this.rpc.request('fs_watch', { session_id: sessionId, path: requestedPath, recursive: false }),
      'fs_watch result'
    );
    if (
      stringField(result, 'session_id', 'fs_watch result') !== sessionId ||
      validateFsPath(stringField(result, 'path', 'fs_watch result')) !== requestedPath ||
      result.recursive !== false
    ) {
      throw new FsProtocolError('fs_watch result must confirm a non-recursive watch');
    }
    return stringField(result, 'watch_id', 'fs_watch result');
  }

  async unwatch(sessionId: string, watchId: string): Promise<void> {
    const removed = await this.rpc.request('fs_unwatch', { session_id: sessionId, watch_id: watchId });
    if (removed !== true) {
      throw new FsProtocolError('fs_unwatch result must be true');
    }
  }

  async downloadBytes(sessionId: string, path: string, options: TransferOptions = {}): Promise<FsDownloadResult> {
    const requestedPath = validateFsPath(path);
    const limit = validateLimit(options.maxBytes ?? DEFAULT_BINARY_FILE_LIMIT_BYTES);
    const { retries, timeoutMs } = validateTransferOptions(options);
    let expected: Omit<FsDownloadResult, 'bytes'> | null = null;
    let offset = 0;
    const chunks: Uint8Array[] = [];

    for (let attempt = 0; ; attempt += 1) {
      const startEpoch = this.connectionEpoch;
      let transferId: string | null = null;
      try {
        const opened = record(
          await this.rpc.request('fs_download_open', { session_id: sessionId, path: requestedPath }),
          'fs_download_open result'
        );
        transferId = stringField(opened, 'transfer_id', 'fs_download_open result');
        const chunkSize = validateChunkSize(opened, 'fs_download_open result');
        if (stringField(opened, 'session_id', 'fs_download_open result') !== sessionId) {
          throw new FsProtocolError('fs_download_open returned the wrong session_id');
        }
        const metadata = {
          path: validateFsPath(stringField(opened, 'path', 'fs_download_open result')),
          size: numberField(opened, 'size', 'fs_download_open result'),
          sha256: validateSha256(
            stringField(opened, 'sha256', 'fs_download_open result'),
            'fs_download_open result.sha256'
          ),
          mime: nullableStringField(opened, 'mime', 'fs_download_open result'),
          mtime: nullableNumberField(opened, 'mtime', 'fs_download_open result'),
        };
        if (metadata.path !== requestedPath) {
          throw new FsProtocolError('fs_download_open returned the wrong path');
        }
        if (metadata.size > limit) {
          throw new FsFileTooLargeError(metadata.size, limit);
        }
        if (expected && (metadata.size !== expected.size || metadata.sha256 !== expected.sha256)) {
          throw new FsProtocolError('File changed while resuming a download after reconnect');
        }
        expected ??= metadata;

        while (offset < expected.size) {
          const response = record(
            await this.rpc.request('fs_download_read', {
              session_id: sessionId,
              transfer_id: transferId,
              offset,
              length: Math.min(chunkSize, expected.size - offset),
            }),
            'fs_download_read result'
          );
          const responseOffset = numberField(response, 'offset', 'fs_download_read result');
          const declaredBytes = numberField(response, 'bytes', 'fs_download_read result');
          const responseSize = numberField(response, 'size', 'fs_download_read result');
          const data = decodeBase64(stringField(response, 'data', 'fs_download_read result'));
          if (
            stringField(response, 'transfer_id', 'fs_download_read result') !== transferId ||
            responseOffset !== offset ||
            responseSize !== expected.size ||
            declaredBytes !== data.byteLength ||
            data.byteLength > chunkSize ||
            typeof response.eof !== 'boolean'
          ) {
            throw new FsProtocolError('fs_download_read returned an invalid offset or chunk length');
          }
          if (data.byteLength === 0 && response.eof !== true) {
            throw new FsProtocolError('fs_download_read made no progress before EOF');
          }
          chunks.push(data);
          offset += data.byteLength;
          if (response.eof === true && offset !== expected.size) {
            throw new FsProtocolError('fs_download_read reached EOF before the declared size');
          }
        }

        const bytes = new Uint8Array(offset);
        let writeOffset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, writeOffset);
          writeOffset += chunk.byteLength;
        }
        if ((await sha256(bytes)) !== expected.sha256) {
          throw new FsProtocolError('Downloaded bytes do not match the server SHA-256 digest');
        }
        return { ...expected, bytes };
      } catch (error) {
        if (attempt >= retries || !isRetryableDisconnect(this.rpc, startEpoch, this.connectionEpoch)) {
          throw error;
        }
        await this.waitForConnected(timeoutMs);
      } finally {
        if (transferId && this.rpc.connectionState === 'connected') {
          await this.rpc
            .request('fs_download_close', { session_id: sessionId, transfer_id: transferId })
            .catch(() => {});
        }
      }
    }
  }

  async uploadBytes(
    sessionId: string,
    path: string,
    bytes: Uint8Array,
    options: UploadOptions = {}
  ): Promise<FsUploadResult> {
    const requestedPath = validateFsPath(path);
    const limit = validateLimit(options.maxBytes ?? DEFAULT_BINARY_FILE_LIMIT_BYTES);
    const uploadBytes = Uint8Array.from(bytes);
    if (uploadBytes.byteLength > limit) {
      throw new FsFileTooLargeError(uploadBytes.byteLength, limit);
    }
    const digest = await sha256(uploadBytes);
    const expectedSha256 = options.expectedSha256
      ? validateSha256(options.expectedSha256, 'expectedSha256')
      : undefined;
    const { retries, timeoutMs } = validateTransferOptions(options);

    for (let attempt = 0; ; attempt += 1) {
      const startEpoch = this.connectionEpoch;
      let transferId: string | null = null;
      let committed = false;
      try {
        const opened = record(
          await this.rpc.request('fs_upload_open', {
            session_id: sessionId,
            path: requestedPath,
            size: uploadBytes.byteLength,
            sha256: digest,
            expected_sha256: expectedSha256,
            overwrite: options.overwrite,
          }),
          'fs_upload_open result'
        );
        transferId = stringField(opened, 'transfer_id', 'fs_upload_open result');
        const chunkSize = validateChunkSize(opened, 'fs_upload_open result');
        if (
          stringField(opened, 'session_id', 'fs_upload_open result') !== sessionId ||
          validateFsPath(stringField(opened, 'path', 'fs_upload_open result')) !== requestedPath
        ) {
          throw new FsProtocolError('fs_upload_open returned the wrong session or path');
        }
        for (let offset = 0; offset < uploadBytes.byteLength; offset += chunkSize) {
          const chunk = uploadBytes.subarray(offset, Math.min(offset + chunkSize, uploadBytes.byteLength));
          const response = record(
            await this.rpc.request('fs_upload_chunk', {
              session_id: sessionId,
              transfer_id: transferId,
              offset,
              data: encodeBase64(chunk),
            }),
            'fs_upload_chunk result'
          );
          if (
            stringField(response, 'transfer_id', 'fs_upload_chunk result') !== transferId ||
            numberField(response, 'size', 'fs_upload_chunk result') !== uploadBytes.byteLength ||
            numberField(response, 'received', 'fs_upload_chunk result') !== offset + chunk.byteLength
          ) {
            throw new FsProtocolError('fs_upload_chunk returned an invalid received offset');
          }
        }
        const result = record(
          await this.rpc.request('fs_upload_commit', { session_id: sessionId, transfer_id: transferId }),
          'fs_upload_commit result'
        );
        const parsed = {
          path: validateFsPath(stringField(result, 'path', 'fs_upload_commit result')),
          size: numberField(result, 'size', 'fs_upload_commit result'),
          sha256: validateSha256(
            stringField(result, 'sha256', 'fs_upload_commit result'),
            'fs_upload_commit result.sha256'
          ),
        };
        if (parsed.path !== requestedPath || parsed.size !== uploadBytes.byteLength || parsed.sha256 !== digest) {
          throw new FsProtocolError('fs_upload_commit returned metadata that does not match the uploaded bytes');
        }
        committed = true;
        return parsed;
      } catch (error) {
        if (attempt >= retries || !isRetryableDisconnect(this.rpc, startEpoch, this.connectionEpoch)) {
          throw error;
        }
        await this.waitForConnected(timeoutMs);
      } finally {
        if (transferId && !committed && this.rpc.connectionState === 'connected') {
          await this.rpc.request('fs_upload_abort', { session_id: sessionId, transfer_id: transferId }).catch(() => {});
        }
      }
    }
  }

  async readTextFile(sessionId: string, path: string, options: TransferOptions = {}): Promise<TextFileReadResult> {
    const downloaded = await this.downloadBytes(sessionId, path, {
      ...options,
      maxBytes: options.maxBytes ?? DEFAULT_TEXT_FILE_LIMIT_BYTES,
    });
    const metadata: TextFileMetadata = downloaded;
    const binaryReason = detectBinary(downloaded.bytes);
    if (binaryReason) {
      return { ...metadata, kind: 'binary', reason: binaryReason as 'nul-byte' | 'control-characters' };
    }
    const hasBom =
      downloaded.bytes.length >= 3 &&
      downloaded.bytes[0] === 0xef &&
      downloaded.bytes[1] === 0xbb &&
      downloaded.bytes[2] === 0xbf;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        hasBom ? downloaded.bytes.subarray(3) : downloaded.bytes
      );
      return {
        ...metadata,
        kind: 'text',
        text,
        encoding: hasBom ? 'utf-8-bom' : 'utf-8',
        ...detectNewlineStyle(text),
      };
    } catch {
      return { ...metadata, kind: 'binary', reason: 'invalid-utf8' };
    }
  }

  async writeTextFile(
    sessionId: string,
    path: string,
    text: string,
    options: WriteTextOptions = {}
  ): Promise<FsUploadResult> {
    const normalized = options.newline ? normalizeNewlines(text, options.newline) : text;
    const content = new TextEncoder().encode(normalized);
    let bytes = content;
    if (options.bom) {
      bytes = new Uint8Array(content.byteLength + 3);
      bytes.set([0xef, 0xbb, 0xbf]);
      bytes.set(content, 3);
    }
    return this.uploadBytes(sessionId, path, bytes, {
      ...options,
      maxBytes: options.maxBytes ?? DEFAULT_TEXT_FILE_LIMIT_BYTES,
    });
  }

  private async waitForConnected(timeoutMs: number): Promise<void> {
    if (this.rpc.connectionState === 'connected') {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        settled = true;
        unsubscribe();
        reject(new Error('Timed out waiting for filesystem RPC reconnect'));
      }, timeoutMs);
      const subscription = this.rpc.onConnectionState((state) => {
        if (state === 'connected') {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      unsubscribe = subscription;
      if (settled) {
        unsubscribe();
      }
    });
  }
}

export interface WatchEvent {
  type: 'created' | 'modified' | 'deleted';
  path: string;
  entryType: FsEntryType;
}

export type WatchRescanReason = 'initial' | 'reconnect' | 'event_overflow' | 'scan_limit_exceeded';

export interface WatchCallbacks {
  onEvents?(events: WatchEvent[]): void;
  onRescan?(listing: FsListResult, reason: WatchRescanReason): void;
  onError?(error: unknown): void;
  onEvicted?(): void;
  /** A scan-limit watch has terminated; expand fewer/narrower directories. */
  onNarrowerWatchRequired?(): void;
}

interface WatchClient {
  watch(sessionId: string, path: string): Promise<string>;
  unwatch(sessionId: string, watchId: string): Promise<void>;
  list(sessionId: string, path: string, recursive?: boolean): Promise<FsListResult>;
  on<Event extends 'fs_events' | 'fs_rescan_required'>(
    event: Event,
    handler: (payload: RpcNotificationMap[Event]) => void
  ): () => void;
  onConnectionState(handler: (state: RPCConnectionState) => void): () => void;
}

interface WatchEntry {
  path: string;
  watchId: string | null;
  callbacks: Set<WatchCallbacks>;
  lastUsed: number;
  generation: number;
  terminated: boolean;
}

export class WatchRegistry {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly watchIds = new Map<string, WatchEntry>();
  private readonly unsubscribers: Array<() => void>;
  private state: RPCConnectionState = 'disconnected';
  private clock = 0;
  private work: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly client: WatchClient,
    private readonly sessionId: string,
    private readonly limit = DEFAULT_WATCH_LIMIT
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLIENT_WATCHES) {
      throw new RangeError(`watch limit must be between 1 and ${MAX_CLIENT_WATCHES}`);
    }
    this.unsubscribers = [
      client.on('fs_events', (payload) => this.handleEvents(payload)),
      client.on('fs_rescan_required', (payload) => this.handleRescanRequired(payload)),
      client.onConnectionState((state) => this.handleConnectionState(state)),
    ];
  }

  get size(): number {
    return this.entries.size;
  }

  async subscribe(path: string, callbacks: WatchCallbacks): Promise<() => Promise<void>> {
    if (this.disposed) {
      throw new Error('WatchRegistry is disposed');
    }
    const watchedPath = validateFsPath(path);
    let entry = this.entries.get(watchedPath);
    if (!entry) {
      if (this.entries.size >= this.limit) {
        const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
        await this.removeEntry(oldest, true);
      }
      entry = {
        path: watchedPath,
        watchId: null,
        callbacks: new Set(),
        lastUsed: ++this.clock,
        generation: 0,
        terminated: false,
      };
      this.entries.set(watchedPath, entry);
    }
    entry.lastUsed = ++this.clock;
    entry.callbacks.add(callbacks);
    if (this.state === 'connected' && !entry.watchId && !entry.terminated) {
      await this.enqueue(() => this.install(entry!, 'initial'));
    }
    let active = true;
    return async () => {
      if (!active) {
        return;
      }
      active = false;
      entry!.callbacks.delete(callbacks);
      if (entry!.callbacks.size === 0) {
        await this.removeEntry(entry!, false);
      }
    };
  }

  touch(path: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      entry.lastUsed = ++this.clock;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    await Promise.all([...this.entries.values()].map((entry) => this.removeEntry(entry, false)));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.work.then(operation, operation);
    this.work = next.catch(() => {});
    return next;
  }

  private handleConnectionState(state: RPCConnectionState): void {
    const reconnected = state === 'connected' && this.state !== 'connected';
    this.state = state;
    if (state !== 'connected') {
      this.watchIds.clear();
      for (const entry of this.entries.values()) {
        entry.watchId = null;
        entry.generation += 1;
      }
    } else if (reconnected && this.entries.size > 0) {
      void this.enqueue(async () => {
        for (const entry of this.entries.values()) {
          if (!entry.terminated) {
            await this.install(entry, 'reconnect');
          }
        }
      });
    }
  }

  private async install(entry: WatchEntry, reason: 'initial' | 'reconnect'): Promise<void> {
    const generation = ++entry.generation;
    try {
      const watchId = await this.client.watch(this.sessionId, entry.path);
      if (
        this.disposed ||
        !this.entries.has(entry.path) ||
        generation !== entry.generation ||
        this.state !== 'connected'
      ) {
        await this.client.unwatch(this.sessionId, watchId).catch(() => {});
        return;
      }
      entry.watchId = watchId;
      this.watchIds.set(watchId, entry);
      await this.rescan(entry, reason);
    } catch (error) {
      this.reportError(entry, error);
    }
  }

  private handleEvents(payload: FsEventsParams): void {
    if (payload.session_id !== this.sessionId) {
      return;
    }
    const entry = this.watchIds.get(payload.watch_id);
    if (!entry) {
      return;
    }
    try {
      if (!Array.isArray(payload.events)) {
        throw new FsProtocolError('fs_events.events must be an array');
      }
      const events = payload.events.map((item, index) => {
        const event = record(item, `fs_events.events[${index}]`);
        const type = stringField(event, 'type', `fs_events.events[${index}]`);
        const entryType = stringField(event, 'entry_type', `fs_events.events[${index}]`);
        if (!['created', 'modified', 'deleted'].includes(type) || (entryType !== 'file' && entryType !== 'directory')) {
          throw new FsProtocolError(`fs_events.events[${index}] has an unsupported type`);
        }
        return {
          type: type as WatchEvent['type'],
          path: validateFsPath(stringField(event, 'path', `fs_events.events[${index}]`)),
          entryType: entryType as FsEntryType,
        };
      });
      entry.lastUsed = ++this.clock;
      for (const callback of entry.callbacks) {
        callback.onEvents?.(events);
      }
    } catch (error) {
      this.reportError(entry, error);
    }
  }

  private handleRescanRequired(payload: FsRescanRequiredParams): void {
    if (payload.session_id !== this.sessionId) {
      return;
    }
    const entry = this.watchIds.get(payload.watch_id);
    if (!entry) {
      return;
    }
    const reason = payload.reason;
    if (reason !== 'event_overflow' && reason !== 'scan_limit_exceeded') {
      this.reportError(entry, new FsProtocolError(`Unsupported fs_rescan_required reason: ${reason}`));
      return;
    }
    if (reason === 'scan_limit_exceeded') {
      this.watchIds.delete(payload.watch_id);
      entry.watchId = null;
      entry.generation += 1;
      entry.terminated = true;
      for (const callback of entry.callbacks) {
        callback.onNarrowerWatchRequired?.();
      }
    }
    void this.enqueue(() => this.rescan(entry, reason));
  }

  private async rescan(entry: WatchEntry, reason: WatchRescanReason): Promise<void> {
    try {
      const listing = await this.client.list(this.sessionId, entry.path, false);
      for (const callback of entry.callbacks) {
        callback.onRescan?.(listing, reason);
      }
    } catch (error) {
      this.reportError(entry, error);
    }
  }

  private async removeEntry(entry: WatchEntry, evicted: boolean): Promise<void> {
    this.entries.delete(entry.path);
    entry.generation += 1;
    if (entry.watchId) {
      this.watchIds.delete(entry.watchId);
      const watchId = entry.watchId;
      entry.watchId = null;
      if (this.state === 'connected') {
        await this.client.unwatch(this.sessionId, watchId).catch(() => {});
      }
    }
    if (evicted) {
      for (const callback of entry.callbacks) {
        callback.onEvicted?.();
      }
    }
  }

  private reportError(entry: WatchEntry, error: unknown): void {
    for (const callback of entry.callbacks) {
      callback.onError?.(error);
    }
  }
}
