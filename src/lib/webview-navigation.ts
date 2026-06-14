export const WEBVIEW_ERR_ABORTED = -3;
export const DEFAULT_WEBVIEW_MAX_INITIAL_RETRIES = 3;
export const DEFAULT_WEBVIEW_RETRY_BASE_DELAY_MS = 750;
export const DEFAULT_WEBVIEW_RETRY_MAX_DELAY_MS = 15_000;

export function isAbortErrorCode(code: number | null | undefined): boolean {
  return code === WEBVIEW_ERR_ABORTED;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const value = error as { errno?: unknown; code?: unknown; message?: unknown };
  return (
    value.errno === WEBVIEW_ERR_ABORTED ||
    value.code === 'ERR_ABORTED' ||
    String(value.message ?? '').includes('ERR_ABORTED')
  );
}

export function shouldRetryInitialLoad(args: {
  errorCode: number | null | undefined;
  ready: boolean;
  attempt: number;
  maxAttempts?: number;
}): boolean {
  const maxAttempts = args.maxAttempts ?? DEFAULT_WEBVIEW_MAX_INITIAL_RETRIES;
  return !args.ready && !isAbortErrorCode(args.errorCode) && args.attempt < maxAttempts;
}

export function getRetryDelayMs(args: { attempt: number; baseDelayMs?: number; maxDelayMs?: number }): number {
  const baseDelayMs = args.baseDelayMs ?? DEFAULT_WEBVIEW_RETRY_BASE_DELAY_MS;
  const maxDelayMs = args.maxDelayMs ?? DEFAULT_WEBVIEW_RETRY_MAX_DELAY_MS;
  return Math.min(maxDelayMs, Math.round(baseDelayMs * Math.pow(1.4, args.attempt)));
}
