import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoRetry, type UseAutoRetryOptions, type UseAutoRetryResult } from './use-auto-retry';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let result: UseAutoRetryResult;

function Harness(props: UseAutoRetryOptions) {
  result = useAutoRetry(props);
  return null;
}

const render = (props: UseAutoRetryOptions) => {
  act(() => root.render(<Harness {...props} />));
};

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useAutoRetry', () => {
  it('stays idle while nothing is failing', () => {
    const retry = vi.fn();
    render({ failing: false, healthy: true, retry });
    advance(120_000);
    expect(retry).not.toHaveBeenCalled();
    expect(result).toEqual({ retrying: false, exhausted: false, attempts: 0 });
  });

  it('retries on a 1.5s, 3s, 6s backoff capped at 10s while failing persists', () => {
    const retry = vi.fn();
    render({ failing: true, healthy: false, retry });
    expect(result.retrying).toBe(true);
    expect(result.exhausted).toBe(false);

    advance(1499);
    expect(retry).not.toHaveBeenCalled();
    advance(1);
    expect(retry).toHaveBeenCalledTimes(1);

    advance(2999);
    expect(retry).toHaveBeenCalledTimes(1);
    advance(1);
    expect(retry).toHaveBeenCalledTimes(2);

    advance(6000);
    expect(retry).toHaveBeenCalledTimes(3);

    advance(10_000);
    expect(retry).toHaveBeenCalledTimes(4);
    advance(10_000);
    expect(retry).toHaveBeenCalledTimes(5);
    expect(result.attempts).toBe(5);
  });

  it('keeps the streak clock running across an in-flight attempt', () => {
    const retry = vi.fn();
    render({ failing: true, healthy: false, retry });
    advance(1500);
    expect(retry).toHaveBeenCalledTimes(1);

    // The attempt moved the watched thing out of its failed state.
    render({ failing: false, healthy: false, retry });
    advance(30_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.retrying).toBe(true);

    // It failed again: next delay continues the backoff, not a fresh 1.5s.
    render({ failing: true, healthy: false, retry });
    advance(1500);
    expect(retry).toHaveBeenCalledTimes(1);
    advance(1500);
    expect(retry).toHaveBeenCalledTimes(2);

    // 60s since the first failure, counted through the quiet stretch.
    advance(60_000 - 1500 - 30_000 - 3000);
    expect(result.exhausted).toBe(true);
  });

  it('flips to exhausted after 60 seconds and keeps retrying behind the card', () => {
    const retry = vi.fn();
    render({ failing: true, healthy: false, retry });
    advance(59_999);
    expect(result.exhausted).toBe(false);
    expect(result.retrying).toBe(true);
    advance(1);
    expect(result.exhausted).toBe(true);
    expect(result.retrying).toBe(false);

    const before = retry.mock.calls.length;
    advance(10_000);
    expect(retry.mock.calls.length).toBeGreaterThan(before);
  });

  it('clears everything once the watched thing is healthy again', () => {
    const retry = vi.fn();
    render({ failing: true, healthy: false, retry });
    advance(70_000);
    expect(result.exhausted).toBe(true);

    render({ failing: false, healthy: true, retry });
    expect(result).toEqual({ retrying: false, exhausted: false, attempts: 0 });
    const calls = retry.mock.calls.length;
    advance(60_000);
    expect(retry).toHaveBeenCalledTimes(calls);

    // A later failure starts a brand-new streak with the short first delay.
    render({ failing: true, healthy: false, retry });
    expect(result.exhausted).toBe(false);
    advance(1500);
    expect(retry).toHaveBeenCalledTimes(calls + 1);
  });

  it('uses the latest retry callback and honours custom schedules', () => {
    const first = vi.fn();
    const second = vi.fn();
    render({ failing: true, healthy: false, retry: first, delaysMs: [100, 200], giveUpAfterMs: 1000 });
    render({ failing: true, healthy: false, retry: second, delaysMs: [100, 200], giveUpAfterMs: 1000 });
    advance(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    advance(200);
    expect(second).toHaveBeenCalledTimes(2);
    advance(200);
    expect(second).toHaveBeenCalledTimes(3);
    advance(500);
    expect(result.exhausted).toBe(true);
  });

  it('cancels pending timers on unmount', () => {
    const retry = vi.fn();
    render({ failing: true, healthy: false, retry });
    act(() => root.unmount());
    root = createRoot(container);
    advance(120_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
