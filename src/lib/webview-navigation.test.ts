import { describe, expect, it } from 'vitest';

import {
  getRetryDelayMs,
  isAbortError,
  isAbortErrorCode,
  shouldRetryInitialLoad,
  WEBVIEW_ERR_ABORTED,
} from '@/lib/webview-navigation';

describe('webview navigation helpers', () => {
  it('recognizes Electron aborted navigation errors', () => {
    expect(isAbortErrorCode(WEBVIEW_ERR_ABORTED)).toBe(true);
    expect(isAbortError({ errno: WEBVIEW_ERR_ABORTED })).toBe(true);
    expect(isAbortError({ code: 'ERR_ABORTED' })).toBe(true);
    expect(isAbortError(new Error('ERR_ABORTED (-3) loading https://example.com'))).toBe(true);
  });

  it('does not retry aborted, ready, or exhausted initial loads', () => {
    expect(shouldRetryInitialLoad({ errorCode: WEBVIEW_ERR_ABORTED, ready: false, attempt: 0 })).toBe(false);
    expect(shouldRetryInitialLoad({ errorCode: -105, ready: true, attempt: 0 })).toBe(false);
    expect(shouldRetryInitialLoad({ errorCode: -105, ready: false, attempt: 3, maxAttempts: 3 })).toBe(false);
  });

  it('retries transient initial failures under the attempt cap', () => {
    expect(shouldRetryInitialLoad({ errorCode: -105, ready: false, attempt: 0, maxAttempts: 3 })).toBe(true);
    expect(shouldRetryInitialLoad({ errorCode: -105, ready: false, attempt: 2, maxAttempts: 3 })).toBe(true);
  });

  it('caps retry delays', () => {
    expect(getRetryDelayMs({ attempt: 0, baseDelayMs: 750, maxDelayMs: 1000 })).toBe(750);
    expect(getRetryDelayMs({ attempt: 10, baseDelayMs: 750, maxDelayMs: 1000 })).toBe(1000);
  });
});
