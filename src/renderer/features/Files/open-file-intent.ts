import { validateFsPath } from '@/renderer/omniagents-ui/rpc/fs';

export type OpenFileIntentSource = 'git-diff' | 'tool-result' | 'code-block' | 'artifact' | 'unknown';

/** One-based source location. Omit `endLine` to target a single caret position. */
export type OpenFileLocation = Readonly<{
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}>;

/** A session-scoped request using the canonical workspace-relative path spelling. */
export type OpenFileIntent = Readonly<{
  sessionId: string;
  path: string;
  location?: OpenFileLocation;
  source?: OpenFileIntentSource;
}>;

export type OpenFileFailureReason =
  | 'invalid-intent'
  | 'invalid-path'
  | 'unknown-session'
  | 'workspace-unavailable'
  | 'unsupported'
  | 'missing-file'
  | 'not-a-file'
  | 'open-failed';

export type OpenFileResult =
  | Readonly<{
      status: 'opened';
      requestId: string;
      sessionId: string;
      path: string;
      location?: OpenFileLocation;
    }>
  | Readonly<{
      status: 'failed';
      requestId: string;
      sessionId: string;
      path: string;
      reason: OpenFileFailureReason;
      message: string;
    }>;

export type OpenFileResultEvent = Readonly<{
  intent: OpenFileIntent;
  result: OpenFileResult;
}>;

export type OpenFileDispatchOptions = Readonly<{
  /** Allows callers to activate the Files surface immediately before dispatch. */
  waitForTargetMs?: number;
  signal?: AbortSignal;
}>;

export type OpenFileTargetRequest = Readonly<{
  requestId: string;
  intent: OpenFileIntent;
}>;

export type OpenFileTarget = (request: OpenFileTargetRequest) => Promise<OpenFileResult>;

const targets = new Map<string, OpenFileTarget[]>();
const targetWaiters = new Map<string, Set<(target: OpenFileTarget | null) => void>>();
const resultListeners = new Set<(event: OpenFileResultEvent) => void>();
let nextRequestId = 1;

function activeTarget(sessionId: string): OpenFileTarget | null {
  return targets.get(sessionId)?.at(-1) ?? null;
}

function failure(
  requestId: string,
  intent: Pick<OpenFileIntent, 'sessionId' | 'path'>,
  reason: OpenFileFailureReason,
  message: string
): OpenFileResult {
  return { status: 'failed', requestId, sessionId: intent.sessionId, path: intent.path, reason, message };
}

function validatePositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function validateLocation(location: OpenFileLocation | undefined): void {
  if (!location) {
    return;
  }
  validatePositiveInteger(location.line, 'location.line');
  validatePositiveInteger(location.column, 'location.column');
  validatePositiveInteger(location.endLine, 'location.endLine');
  validatePositiveInteger(location.endColumn, 'location.endColumn');
  if (location.endColumn !== undefined && location.endLine === undefined) {
    throw new RangeError('location.endColumn requires location.endLine');
  }
  if (location.endLine !== undefined && location.endLine < location.line) {
    throw new RangeError('location.endLine must not precede location.line');
  }
  if (
    location.endLine === location.line &&
    location.endColumn !== undefined &&
    location.endColumn < (location.column ?? 1)
  ) {
    throw new RangeError('location.endColumn must not precede location.column');
  }
}

function emitResult(intent: OpenFileIntent, result: OpenFileResult): OpenFileResult {
  const event = { intent, result };
  for (const listener of resultListeners) {
    listener(event);
  }
  return result;
}

async function waitForTarget(
  sessionId: string,
  waitForTargetMs: number,
  signal: AbortSignal | undefined
): Promise<OpenFileTarget | null> {
  if (signal?.aborted) {
    return null;
  }
  const current = activeTarget(sessionId);
  if (current || waitForTargetMs <= 0) {
    return current;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (target: OpenFileTarget | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const sessionWaiters = targetWaiters.get(sessionId);
      sessionWaiters?.delete(finish);
      if (sessionWaiters?.size === 0) {
        targetWaiters.delete(sessionId);
      }
      resolve(target);
    };
    const abort = () => finish(null);
    const timer = setTimeout(() => finish(null), waitForTargetMs);
    const sessionWaiters = targetWaiters.get(sessionId) ?? new Set();
    sessionWaiters.add(finish);
    targetWaiters.set(sessionId, sessionWaiters);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Register a mounted Files surface for one exact session. The most recently
 * mounted target wins, and unregistering reveals the previous target.
 */
export function registerOpenFileTarget(sessionId: string, target: OpenFileTarget): () => void {
  if (!sessionId) {
    throw new Error('An open-file target requires a session id');
  }
  const sessionTargets = targets.get(sessionId) ?? [];
  sessionTargets.push(target);
  targets.set(sessionId, sessionTargets);
  for (const waiter of targetWaiters.get(sessionId) ?? []) {
    waiter(target);
  }
  return () => {
    const currentTargets = targets.get(sessionId);
    if (!currentTargets) {
      return;
    }
    const index = currentTargets.lastIndexOf(target);
    if (index >= 0) {
      currentTargets.splice(index, 1);
    }
    if (currentTargets.length === 0) {
      targets.delete(sessionId);
    }
  };
}

/** Subscribe to both successful and failed requests for telemetry or UI feedback. */
export function subscribeOpenFileResults(listener: (event: OpenFileResultEvent) => void): () => void {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

/**
 * Dispatch an open-file request from Git diffs, tool results, code blocks, or
 * artifacts. A short target wait makes "activate Files, then dispatch" safe.
 */
export async function dispatchOpenFileIntent(
  intent: OpenFileIntent,
  options: OpenFileDispatchOptions = {}
): Promise<OpenFileResult> {
  const requestId = `open-file-${nextRequestId++}`;
  if (!intent.sessionId) {
    return emitResult(intent, failure(requestId, intent, 'invalid-intent', 'A session id is required to open a file.'));
  }
  try {
    validateFsPath(intent.path);
  } catch (error) {
    return emitResult(
      intent,
      failure(requestId, intent, 'invalid-path', error instanceof Error ? error.message : 'The file path is invalid.')
    );
  }
  if (intent.path === '.') {
    return emitResult(
      intent,
      failure(requestId, intent, 'invalid-path', 'A file path is required; the workspace root cannot be opened.')
    );
  }
  try {
    validateLocation(intent.location);
  } catch (error) {
    return emitResult(
      intent,
      failure(requestId, intent, 'invalid-intent', error instanceof Error ? error.message : 'The location is invalid.')
    );
  }

  const target = await waitForTarget(intent.sessionId, options.waitForTargetMs ?? 1_500, options.signal);
  if (!target) {
    return emitResult(
      intent,
      failure(requestId, intent, 'unknown-session', `No Files surface is available for session ${intent.sessionId}.`)
    );
  }
  try {
    return emitResult(intent, await target({ requestId, intent }));
  } catch (error) {
    return emitResult(
      intent,
      failure(
        requestId,
        intent,
        'open-failed',
        error instanceof Error ? error.message : `Could not open ${intent.path}.`
      )
    );
  }
}

/** Semantic alias for event-producing callers that do not own the Files surface. */
export const emitOpenFileIntent = dispatchOpenFileIntent;
