import type {
  FsClient,
  TextFileReadResult,
  WatchCallbacks,
  WatchEvent,
  WatchRegistry,
} from '@/renderer/omniagents-ui/rpc/fs';
import {
  type FileEditorFile,
  type FileEditorIdentity,
  type FileEditorIO,
  FileEditorSaveConflictError,
  type FileEditorWatchEvent,
} from '@/shared/machines/file-editor.machine';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

export class BinaryFileEditorError extends Error {
  constructor(readonly path: string) {
    super(`${path} is binary and cannot be edited as text`);
    this.name = 'BinaryFileEditorError';
  }
}

const WATCH_RETRY_BASE_MS = 250;
const WATCH_RETRY_MAX_MS = 5_000;
const WATCH_RETRY_RESET_MS = 30_000;

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '.' : path.slice(0, separator);
}

function textFile(result: TextFileReadResult): FileEditorFile {
  if (result.kind === 'binary') {
    throw new BinaryFileEditorError(result.path);
  }
  return {
    content: result.text,
    version: result.sha256,
    encoding: result.encoding,
    newline: result.newline,
    trailingNewline: result.trailingNewline,
  };
}

function rpcReason(error: unknown): string | null {
  if (!(error instanceof OmniagentsRpcError) || !error.data || typeof error.data !== 'object') {
    return null;
  }
  const reason = (error.data as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OmniagentsRpcError && error.code === -32061;
}

function isPreconditionFailure(error: unknown): boolean {
  const reason = rpcReason(error);
  return (
    error instanceof OmniagentsRpcError &&
    error.code === -32062 &&
    (reason === 'precondition_failed' || reason === 'target_exists')
  );
}

/** File-editor machine adapter backed by the negotiated filesystem protocol. */
export class FsFileEditorIO implements FileEditorIO {
  constructor(
    private readonly fsClient: FsClient,
    private readonly watchRegistry: WatchRegistry,
    private readonly environmentId: string
  ) {}

  async load(identity: FileEditorIdentity): Promise<FileEditorFile> {
    return textFile(await this.fsClient.readTextFile(this.environmentId, identity.path));
  }

  async save(input: Parameters<FileEditorIO['save']>[0]): Promise<FileEditorFile> {
    const newline = ['lf', 'crlf', 'cr'].includes(input.newline) ? (input.newline as 'lf' | 'crlf' | 'cr') : undefined;
    try {
      const result = await this.fsClient.writeTextFile(this.environmentId, input.identity.path, input.content, {
        bom: input.encoding === 'utf-8-bom',
        expectedSha256: input.expectedVersion ?? undefined,
        newline,
        overwrite: input.expectedVersion !== null,
      });
      return {
        content: input.content,
        version: result.sha256,
        encoding: input.encoding,
        newline: input.newline,
        trailingNewline: input.content.endsWith('\n') || input.content.endsWith('\r'),
      };
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      let diskFile: FileEditorFile | null;
      try {
        diskFile = await this.load(input.identity);
      } catch (loadError) {
        if (!isNotFound(loadError)) {
          throw loadError;
        }
        diskFile = null;
      }
      throw new FileEditorSaveConflictError(diskFile);
    }
  }

  watch(identity: FileEditorIdentity, emit: (event: FileEditorWatchEvent) => void): () => void {
    let active = true;
    let readGeneration = 0;
    let subscriptionGeneration = 0;
    let unsubscribe: (() => Promise<void>) | null = null;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryResetTimer: ReturnType<typeof setTimeout> | null = null;
    const path = parentPath(identity.path);

    const clearRetryReset = () => {
      if (retryResetTimer) {
        clearTimeout(retryResetTimer);
        retryResetTimer = null;
      }
    };

    const markActive = () => {
      retryAttempt = 0;
      clearRetryReset();
      this.watchRegistry.touch(path);
    };

    const refresh = async () => {
      const generation = ++readGeneration;
      try {
        const file = await this.load(identity);
        if (active && generation === readGeneration) {
          emit({ type: 'EXTERNAL_CHANGE', file });
        }
      } catch (error) {
        if (active && generation === readGeneration && isNotFound(error)) {
          emit({ type: 'EXTERNAL_DELETE' });
        }
      }
    };

    const callbacks: WatchCallbacks = {
      onEvents: (events: WatchEvent[]) => {
        if (!active) {
          return;
        }
        markActive();
        for (const event of events) {
          if (event.path !== identity.path) {
            continue;
          }
          if (event.type === 'deleted') {
            readGeneration += 1;
            emit({ type: 'EXTERNAL_DELETE' });
          } else {
            void refresh();
          }
        }
      },
      onRescan: (listing, reason) => {
        if (!active) {
          return;
        }
        this.watchRegistry.touch(path);
        if (reason !== 'initial') {
          markActive();
        }
        if (listing.entries.some((entry) => entry.path === identity.path && entry.type === 'file')) {
          void refresh();
        } else {
          readGeneration += 1;
          emit({ type: 'EXTERNAL_DELETE' });
        }
      },
      onError: () => {
        // WatchRegistry reports installation/rescan failures through the
        // callback while keeping the subscription entry alive. Re-subscribing
        // prompts another install attempt without surfacing an unhandled
        // promise or spinning while the runtime is unavailable.
        scheduleRetry();
      },
      onEvicted: () => {
        if (!active) {
          return;
        }
        unsubscribe = null;
        scheduleRetry();
      },
    };

    const subscribe = () => {
      if (!active) {
        return;
      }
      const generation = ++subscriptionGeneration;
      this.watchRegistry.touch(path);
      void this.watchRegistry
        .subscribe(path, callbacks)
        .then((dispose) => {
          if (!active || generation !== subscriptionGeneration) {
            return dispose();
          }
          unsubscribe = dispose;
          clearRetryReset();
          retryResetTimer = setTimeout(() => {
            retryResetTimer = null;
            retryAttempt = 0;
          }, WATCH_RETRY_RESET_MS);
        })
        .catch(() => {
          if (active && generation === subscriptionGeneration) {
            scheduleRetry();
          }
        });
    };

    function scheduleRetry() {
      if (!active || retryTimer) {
        return;
      }
      clearRetryReset();
      const delay = Math.min(WATCH_RETRY_BASE_MS * 2 ** retryAttempt, WATCH_RETRY_MAX_MS);
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        subscribe();
      }, delay);
    }

    subscribe();
    return () => {
      if (!active) {
        return;
      }
      active = false;
      readGeneration += 1;
      subscriptionGeneration += 1;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearRetryReset();
      const dispose = unsubscribe;
      unsubscribe = null;
      if (dispose) {
        void dispose().catch(() => {});
      }
    };
  }
}
